# Scheduler (build step 3)

`reconcile()` makes the OS notification schedule match the database. Each run it does five things:

1. Tidies plan statuses. Expired pauses resume and finished plans end, each by its own time zone. An expired "Pause everything" is cleared. Occurrences left unanswered for 30 minutes are marked missed.
2. If notifications aren't allowed, cancels everything and stops. Plans are untouched, and the next reconcile after permission returns picks them up again.
3. Expands each rule for today plus the next 13 days (`expand.ts`, a pure function). It applies:
   - the plan's dates and status, including a timed pause
   - "Pause everything"
   - "Quiet till…" and "Skip today"
   - the weekend start time
   - plan and global quiet hours ("Can't miss" notifs get through if "Can't miss breaks quiet" is on)
   - the per-plan and global daily caps: the most important notifs are kept, and times already past today still count toward the cap
4. Saves those occurrences. A future one the user already skipped keeps its state, and stale pending rows are deleted. Rows that are still valid keep their id, so running it again changes nothing.
5. Cancels every OS notification and schedules the soonest 60 (`window.ts`), counting "nudge once" follow-ups. If anything is left over, or a plan runs past the 14 days, one more notification after the last says "Open fais-moi to keep your plans running." That's at most 61 of iOS's 64.

It runs on launch, whenever the app comes back to the foreground, after a notification action, and from the background task (best effort; iOS often runs it overnight). Screens should call `runReconcile()` after any edit from step 4 onward. Calls made close together wait for each other instead of overlapping.

## Times and DST

Times are stored as wall-clock in the plan's time zone and turned into instants at schedule time (`tz.ts`, using Intl only). 08:00 stays 08:00 across a DST change. A time skipped by spring-forward (02:30) fires at 03:30. A time that happens twice at fall-back fires the first time.

## Notification actions

| Button | Effect |
|---|---|
| Done | The occurrence becomes `done`. Any snooze still waiting for it is closed. |
| In 30 min | The row that fired becomes `snoozed`, and a one-off snooze row is added 30 minutes later. Snoozing the snooze moves it on again. |
| Skip today | The occurrence becomes `skipped`. |
| (tap) | Opens the app. |

A notif set to nudge once gets one follow-up 30 minutes later if nothing was pressed. Answering the nudge resolves the original.

Priority: silent has no sound, gentle uses the default sound, and critical is Time Sensitive on iOS (the entitlement is in `app.json`). Android gets one channel per priority and inexact alarms. The exact-alarm permissions are explicitly blocked.

Answers reach the app three ways, and all go through `handleAction()`, which ignores repeats:
- the response listener, registered in `index.ts` before the router loads
- the Android background notification task
- `getLastNotificationResponse()` on launch and whenever the app returns to the foreground

## Test on an iPhone

The scheduler logic is covered by tests here. The OS behaviour has to be checked on a device:

```
npm install
npx expo run:ios --device     # needs Xcode and a signing team (Push Notifications + Time Sensitive capabilities)
```

On the Scheduler check screen:
1. **Turn on notifications**, then **Add quick test plan**. Five notifs fire over the next 2–6 minutes.
2. Lock the phone. Check that the plan name shows as the subtitle and each fire shows the three buttons.
3. Press **Done** on "Gentle one" without opening the app, then open the app. Today should show it as done.
4. Press **In 30 min** on "Snooze me". Scheduled with the OS should show a snooze 30 minutes out.
5. Leave "Nudge me" alone. A second notification should arrive 30 minutes later.
6. Turn on a Focus: "Can't miss" should break through (Time Sensitive). "Silent one" should make no sound.
7. **Cold start:** swipe the app away in the app switcher, wait for a notif, and press Done. This is the case iOS may drop, see below.
8. **Add 30-day sample plan:** check that Scheduled with the OS shows 61 of 64, with the keep-alive last.
9. Turn notifications off in Settings and return to the app. The schedule should empty. Turn them back on and it refills.

**Known iOS limit:** the buttons don't open the app, as the brief asks. Apple only delivers that answer while the app is running or suspended. If iOS has terminated the app (swiped away, or evicted for memory), the tap is lost, and the occurrence is marked missed after 30 minutes. If step 7 shows this matters in practice, there are two fixes. One is to let Done open the app briefly. The other is a native notification extension, which is more work.
