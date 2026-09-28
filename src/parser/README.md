# Import parser (build step 1)

A pure TypeScript module with no React Native imports. It turns whatever the user pastes from ChatGPT into a plan draft that the Review and Couldn't-read screens can show.

```ts
import { parsePlan } from './src/parser';

const result = parsePlan(pastedText, {
  today: '2026-09-28',          // optional, defaults to device today
  deviceTz: 'Africa/Lagos',     // optional, defaults to device tz
  defaults: { perDay: 6, quiet: { start: '22:30', end: '06:30' } }, // from New plan
});
// → { status: 'ok' | 'partial' | 'failed', source, plan, notifs, issues }
```

| field | meaning |
|---|---|
| `status` | `ok` → Review. `partial` → Couldn't read (at least one `error` issue; "Use the N we found"). `failed` → no notifs at all. |
| `source` | `fais-moi` / `json` / `text` / `none`. Drives the detected-format chip (`describeSource`). |
| `plan` | `{ title, start, days \| null, tz, perDay, quiet }` with defaults filled in. |
| `notifs` | `{ id, title, icon, at \| null, on, priority, optional, onMiss, enabled, messages[] }`. `on` is canonical: `daily`, `weekdays`, `weekends`, `mon,wed`, or `YYYY-MM-DD`. |
| `issues` | `{ code, severity, fixed, message, notifId?, fixIt? }`. `fixed` = an automatic fix was applied and the message explains it. Otherwise the issue needs a look. `error` issues block "Start plan" (see `blockingIssues`). |

`parsePlan` never throws.

## Pipeline

1. **`extract.ts`**: finds JSON in fenced blocks first, then in any `{…}` or `[…]` span, which covers "json / Copy code" pastes. If `JSON.parse` fails, it tries JSON5 (trailing commas, comments, single quotes), straightens smart quotes, and closes off truncated JSON.
2. **`text.ts`**: the fallback line reader. It handles `8:00 AM — Breakfast: …`, `20:30 Mental reset - …`, title-first lines, markdown tables, headings that set days (`## Saturdays`) and day-by-day lists. Repeated reminders merge into rotating messages. A bullet that looks like a reminder but has no time is kept with `at: null` and gets an error. Any other prose is skipped.
3. **`normalize.ts`**: maps field aliases (`time`, `repeat`, `reminders`, `message`, `start_date`, `length`, and a nested `plan: {…}`), fills defaults, de-duplicates ids and raises per-field issues.
4. **`validate.ts`**: flags notifs in quiet hours and enforces `per_day`. On an over-full weekday, the notif that gives way is chosen in this order: optional first, then lowest priority, then the one firing on the most days, then the one listed last. It loses that day and the issue explains the move. A one-off date that pushes a day over the limit is flagged, not moved.

## Also exported

- `buildPlanPrompt(input)`: the "Copy prompt & open ChatGPT" template.
- `buildFixItPrompt(result)`: the Couldn't-read fix-it prompt, built from each issue's `fixIt`.
- `serializePlan(plan, notifs)`: canonical fais-moi v1 JSON for "Adjust with ChatGPT".
- `messageFor(messages, n)`: the Nth occurrence uses `messages[(n-1) % len]`.
- `PlanV1` / `NotifV1`: the strict zod schema. `SCHEMA_TEXT` is the `{schema}` block in prompts.
- Helpers: `parseTime`, `formatTime`, `parseOn`, `formatOn`, `describeOn`, `formatQuiet`, `endDate`.

## Fixtures

`__fixtures__/` holds messy ChatGPT output. `__tests__/fixtures.test.ts` asserts the exact result for each one.

| fixture | what it exercises |
|---|---|
| 01-clean-v1 | canonical format, no issues |
| 02-prose-around-fence | intro, outro and emoji around a ```json block |
| 03-trailing-commas-comments | JSON5 repair; no `days` → ongoing |
| 04-smart-quotes | “curly” quotes used as delimiters |
| 05-aliases-time-repeat | `time`, `repeat`, `reminders`, `message`, `"30 days"`, unlabelled fence |
| 06-copy-code-no-fence | "json / Copy code" paste from the web UI |
| 07-truncated | answer cut off mid-message |
| 08-over-cap | Sat and Sun at 7 notifs with a limit of 6 → Hydration moved to weekdays |
| 09-quiet-and-dupes | quiet-hours flags, duplicate ids, empty messages |
| 10-text-parsefail | the Couldn't-read case: 3 found, "Evening wind-down" has no time |
| 11-text-lines | headings, bold, numbered lines, `## Saturdays`, `Start:` line |
| 12-markdown-table | table with a Days column |
| 13-day-by-day | Day 1/2/3 lists merged into rotating messages |
| 14-nested-plan-object | `plan: {…}`, day arrays, message objects, `25:00`, `fortnightly` |
| 15-top-level-array | bare array of notifs |
| 16-garbage | a refusal, which fails cleanly |

Run the tests with `npm test`; typecheck with `npm run typecheck`.
