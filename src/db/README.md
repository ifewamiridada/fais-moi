# Database layer (build step 2)

All data stays on the device in SQLite. The repositories take a `Db`, which is the part of expo-sqlite's `SQLiteDatabase` they use (`execAsync`, `runAsync`, `getFirstAsync`, `getAllAsync`, `withTransactionAsync`). That means:

- **In the app:** pass `await SQLite.openDatabaseAsync('fais-moi.db')`. This gets wired up with the Expo app in step 3.
- **In tests:** `__tests__/nodeDb.ts` adapts Node's built-in `node:sqlite`, so the tests run on real SQLite with no native build.

Call `migrate(db)` once at startup. It turns on foreign keys and WAL, then applies any migrations still to run. The version is stored in `PRAGMA user_version`. `MIGRATIONS` is append-only: never edit a migration that has shipped, add a new one.

## Schema

The brief's data model, plus what the designs need:

| table | notes |
|---|---|
| `plan` | As in the brief. Adds `quiet_until` ("Quiet till 6") and `skipped_date` ("Skip today"). `weekend_start` backs "Weekends start at 9:00". |
| `notif` | Adds `key`, the import id (`breakfast`), unique per plan. It is kept for Adjust with ChatGPT and the diff. `at` may be NULL only while the notif is off (a CHECK enforces this). |
| `occurrence` | Adds `local_date`, the plan-local day, for Today and the 7-day strip. Rows are UNIQUE on (notif, fire_at), so `reconcile()` can upsert the same window again without losing states. |
| `settings` | The Quiet tab's global rules plus first-run state, stored as key → JSON. Adding a setting needs no migration. |

Instants (`fire_at`, `paused_until`, `created_at`, …) are epoch ms. Dates and times are wall-clock in the plan's `tz`.

## API

**Plans** (`plans.ts`)
- `createPlan(db, plan, notifs, now?)`: "Start plan". Stores the plan and every notif, including the ones switched off, in one transaction. It refuses enabled notifs with no time or no messages.
- `getPlan`, `listPlans(db, status?)`, `updatePlan(db, id, patch)`.
- `pausePlan(db, id, until | null)`, `resumePlan`, `setPlanQuietUntil`, `setPlanSkippedDate`, `endPlan`, `deletePlan` (deleting cascades to notifs and occurrences).
- `refreshPlanStatuses(db, now?)`: run before every reconcile. It resumes plans whose pause has run out, ends plans past their last day (in their own time zone), and clears expired quiet and skip markers.
- `duplicatePlan(db, id, start)`: "Run again".
- `loadPlanDraft(db, id)`: returns the parser's shapes, ready for `serializePlan()`.
- `planDay(plan, now?)`: "Day 12 of 30".

**Notifs** (`notifs.ts`)
- `listNotifs`, `getNotif`, `addNotif`, `deleteNotif`.
- `updateNotif(db, id, patch)`: the Edit notif sheet. The merged result is checked as a whole.
- `setPlanOnMiss(db, planId, onMiss)`: the Plan screen's "Missed a notif", applied to every notif in the plan.

**Occurrences** (`occurrences.ts`)
- `upsertOccurrence`: idempotent, and keeps a state the user has already set.
- `setOccurrenceState(db, id, state, actedAt?)`: Done, In 30 min or Skip today.
- `listOccurrencesOn(db, date)` (Today) and `listOccurrencesBetween(db, from, to)` (the scheduler window). Both return views with the plan title and the rotated message.
- `markMissed(db, before)`, `deletePendingFrom(db, from)`, `setOsNotificationId`, `clearOsNotificationIds`.
- `planHistory(db, planId, from, to)`: done, snoozed, skipped and missed counts per notif and per day ("Last 7 days", Adjust).

**Settings** (`settings.ts`)
- `getSettings` (with defaults), `updateSettings(patch)`, `isPausedAll(settings, now?)`.

Every write is checked first and throws `ValidationError` with a readable message.
