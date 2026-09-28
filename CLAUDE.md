# fais-moi. — build brief for Claude Code

A mobile app that turns an AI-generated plan into timely, changing notifications.
**The notification is the product.** Everything else exists to make those notifications more useful, personal and timely.

Core loop: Goal → app writes a ChatGPT prompt → user pastes ChatGPT's answer back → app parses → user reviews → notifications fire → user adjusts.

**App name: fais-moi**. Wordmark is lowercase `fais-moi.` in Fraunces Black; app icon mark is `f.`. In code and data, a single scheduled reminder rule is called a **notif** — use that word in code, data and UI copy.

Design references live in `design/` (static HTML mockups of every screen, plus `Handoff.dc.html` and `Brand.dc.html`). Treat them as the visual source of truth for layout, copy, colour and type. Ignore the `<x-dc>`, `<helmet>` and `DCLogic` wrappers — they're from the design tool.

---

## Non-goals (v1)

No habit streaks, gamification, social, analytics dashboards, accounts, cloud sync, in-app AI calls, PDF/XLSX import, custom sounds. Don't add them.

## Stack

- Expo (React Native, TypeScript), Expo Router
- `expo-notifications` — local notifications with action buttons (categories)
- `expo-sqlite` — all data on device, no backend
- `zod` — import schema validation
- `expo-clipboard`, `expo-document-picker` (txt/json/csv/md only)
- Fonts: Fraunces (600, 900) for display moments only; Instrument Sans for UI

## Import format — fais-moi v1

Canonical input is a single JSON object (usually inside a ```json code block in ChatGPT's reply — strip fences and surrounding prose).

```json
{
  "format": "fais-moi/1",
  "plan": "30-Day PCOS Wellness",
  "start": "2026-09-28",
  "days": 30,
  "tz": "Africa/Lagos",
  "limits": { "per_day": 6, "quiet": "22:30-06:30" },
  "notifs": [
    {
      "id": "breakfast",
      "title": "Breakfast",
      "icon": "sun",
      "at": "08:00",
      "on": "daily",
      "priority": "gentle",
      "optional": false,
      "messages": ["Start with a protein-rich breakfast.", "Eggs, beans or yoghurt — pick one."]
    },
    { "id": "meal-prep", "title": "Meal prep day", "at": "10:00", "on": "sat", "messages": ["Prep lunches for the week."] }
  ]
}
```

Rules:
- `on`: `daily` | `weekdays` | `weekends` | comma list of `mon,tue,wed,thu,fri,sat,sun` | ISO date `2026-10-03` (one-off).
- `days` optional → ongoing (no end). `tz` optional → device tz. `limits` optional.
- `messages`: 1..n. The Nth occurrence of a notif uses `messages[(N-1) % len]`.
- `icon` optional, from a fixed set: sun, drop, bowl, move, moon, book, calendar, talk, spark. Unknown → spark.
- Unknown fields ignored. Missing optional fields defaulted.

**Fallback parser** (when no valid JSON): read lines like `8:00 AM — Breakfast: Start with…`, `20:30 Mental reset - What can you release?`. Anything it can't place becomes an `issue` shown on Review — never silently guessed.

**Validation → issues** (shown on the Review screen, each with the auto-fix applied or a "needs a look" state):
- time outside quiet hours → flag
- any day over `per_day` → auto-drop/move the lowest-priority/optional notif, explain it ("Saturday had 7 notifs, limit is 6 → Hydration moved to weekdays")
- duplicate ids → suffix
- empty messages → error

Parser output: `{ plan, notifs, issues[] }`. Write it as a pure module with unit tests. Build a fixture folder of real, messy ChatGPT outputs (markdown bold, extra prose, trailing commas, smart quotes) and test against them.

## Prompt template (copied to clipboard on "Copy prompt & open ChatGPT")

```
Create my notification plan in fais-moi format.

Goal: {goal}
Length: {days} days from {startDate}.
My day: awake {wake}–{sleep}, work {workStart}–{workEnd}.
Limit: no more than {perDay} reminders a day.
Also: {extra}

Rules
– Reply with ONE json code block, nothing else.
– Follow the schema below exactly.
– Write a different message for each day a reminder fires, up to 30, so none feel stale.
– Messages under 90 characters. 24-hour times.

{schema}
```

Then open `https://chat.openai.com/` (deep link) — ChatGPT isn't required; any assistant works.

## Data model (SQLite)

```
plan(id, title, start_date, days NULL, tz, per_day, quiet_start, quiet_end,
     weekend_start NULL, status: active|paused|ended, paused_until NULL, created_at)
notif(id, plan_id, title, icon, at, on_rule, messages_json, priority: silent|gentle|critical,
    optional, on_miss: none|nudge_once, enabled, sort)
occurrence(id, notif_id, fire_at, message_index, os_notification_id NULL,
           state: pending|done|snoozed|skipped|missed, acted_at NULL)
```

## Scheduler — the part that must be right

- iOS caps pending local notifications at **64 per app**. Keep a rolling window: expand rules into occurrences for the next N days, schedule the soonest ≤ 60 with the OS, reserve 1 slot for a final "Open fais-moi to keep your plans running" notification after the last scheduled one.
- Re-plan (`reconcile()`) on: app launch, app foreground, any edit, notification action, background fetch (`expo-background-fetch`, best effort).
- `reconcile()` is idempotent: cancel all OS notifications owned by fais-moi, recompute window from DB, reschedule. Apply per-day cap, quiet hours, paused plans, skipped-today, disabled notifs.
- Store times as wall-clock in the plan tz; handle DST.
- Android: use inexact scheduling; don't require exact-alarm permission.

Notification actions (category per notif): **Done**, **In 30 min** (snooze → schedules a one-off +30m), **Skip today**. Handle them without opening the app; update `occurrence.state`.
`on_miss = nudge_once`: if no action within 30 min, one follow-up.
Priority: silent = no sound; gentle = default; critical = time-sensitive interruption level on iOS.

## Screens (see `design/`)

1. **Today** (`Main.dc.html`) — greeting card with remaining notifs + next one; running-plan chips; timeline of today's occurrences across plans (done ones faded); floating tab bar: Today / Plans / Quiet.
2. **New plan** (`NewPlan.dc.html`) — goal, length (14/30/60/ongoing), awake + work hours, max per day stepper, free text → "Copy prompt & open ChatGPT" / "I already have a plan".
3. **Paste** (`Import.dc.html`) — auto-read clipboard on focus, paste box, upload file, detected-format chip → "Read my plan".
4. **Review** (`Review.dc.html`) — plan title + dates, issues banner, list of notifs with toggle, tap → edit → "Start plan".
5. **Edit notif** (`EditCue.dc.html`, bottom sheet) — icon, title, message (for today's index; "All N messages" list), time, if-missed, repeat days, priority (Silent/Gentle/Can't miss), optional.
6. **Plan** (`Plan.dc.html`) — day X of Y, Pause / Skip today / Quiet till…, settings (per day, quiet hours, weekends, missed), last 7 days strip, "Adjust with ChatGPT".
7. **Notification** (`Lock.dc.html`) — the actual OS notification with actions. Title = notif title, body = today's message, subtitle = plan name.

**Around the flow — required for v1:**

8. **Welcome + permission** (`Welcome.dc.html`) — first launch only. Explain why notifications matter *before* triggering the OS prompt. "Turn on notifications" → request permission → Empty Today. "Not now" → Denied.
9. **Notifications off** (`Denied.dc.html`) — shown when permission is denied/revoked (check on every foreground). "Open Settings" deep-links to the app's settings (`Linking.openSettings()`). Plans stay intact but paused; `reconcile()` resumes when permission returns. Today shows a persistent banner linking here while permission is off.
10. **Today, empty** (`Empty.dc.html`) — no plans yet. Primary CTA → New plan; starter tiles (30-day reset, Study plan, Faith rhythm) pre-fill New plan's goal field; "I have a plan" → Paste.
11. **Couldn't read plan** (`ParseFail.dc.html`) — when the parser returns errors or a partial result. List what was found vs. what's missing; "Copy fix-it prompt" builds a ChatGPT prompt from the specific issues; "Use the N we found" → Review with the problems flagged.
12. **Plans** (`Plans.dc.html`) — Plans tab. Sections: Running (progress + next notification), Paused (with Resume), Finished (with Run again → duplicates plan with a new start date).
13. **Quiet** (`Quiet.dc.html`) — Quiet tab, global rules above all plans: Pause everything (1 hour / till tomorrow / till I'm back), global quiet hours, global daily cap across plans, "Can't miss breaks quiet" toggle, live notification-permission status.

**Designed later (build with sensible defaults for now):** paused/skipped state on Today, All-messages list, time picker (use native), Adjust re-import as a diff, plan-ended summary, notification history.

"Adjust with ChatGPT": copies a prompt with the current plan JSON + last 7 days of done/snoozed/skipped per notif, asking for a revised fais-moi v1 plan. Re-import goes through Review as a diff.

## Design tokens

```
night  #2B0A0E   wine  #5A0E18   signal #B0121F   blush #F6C3CC
blush-soft #FBE3E7   paper #FCF3F1   pollen #E4E69A   sage #2E6A64
text-muted #7D4B52   border #F1D3D8
radius: card 28, field 14–16, pill 999
touch targets ≥ 44
```
Tone: calm, warm, quietly clever. Serif only for the wordmark, greetings, day counts. No emoji in UI chrome (users may put emoji in their own messages).

## Build order

1. Parser + schema + fixtures + tests (no UI).
2. SQLite schema + repository layer.
3. Scheduler `reconcile()` + notification categories/actions; test on a real iOS device.
4. Welcome + permission, Denied, Empty Today.
5. New plan → Paste → Couldn't read → Review → Edit → Start.
6. Today, Plans, Plan, Quiet; pause/skip/quiet.
7. Adjust with ChatGPT.
8. TestFlight.

Start with step 1. Show the parser API and test fixtures before building UI.
