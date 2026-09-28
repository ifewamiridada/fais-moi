import { deviceTz as detectTz, todayIn } from './dates';
import { cleanInput, extractJson } from './extract';
import { normalize, type NormalizeContext } from './normalize';
import { FORMAT, PlanV1 } from './schema';
import { parseText } from './text';
import type { Issue, ParseOptions, ParseResult, Source } from './types';
import { checkQuietHours, enforceDailyCap } from './validate';

export const DEFAULT_PER_DAY = 6;
export const DEFAULT_QUIET = { start: '22:30', end: '06:30' } as const;

/**
 * Turns whatever the user pasted into a plan draft.
 *
 * 1. Look for JSON (code fences first, then any {…}); repair smart quotes, trailing
 *    commas, comments and cut-off endings.
 * 2. No usable JSON → read reminder lines ("8:00 AM — Breakfast: …").
 * 3. Normalise fields (aliases, defaults), then validate: quiet hours, daily cap.
 *
 * Never throws. Everything uncertain comes back as an Issue.
 */
export function parsePlan(input: string, options: ParseOptions = {}): ParseResult {
  const tz = options.deviceTz ?? detectTz();
  const ctx: NormalizeContext = {
    today: options.today ?? todayIn(tz),
    deviceTz: tz,
    perDay: options.defaults?.perDay ?? DEFAULT_PER_DAY,
    quiet: options.defaults?.quiet ?? { ...DEFAULT_QUIET },
    fromText: false,
  };
  const text = cleanInput(input);
  const pre: Issue[] = [];
  let source: Source = 'none';
  let result: ReturnType<typeof normalize> | null = null;

  const json = extractJson(text);
  if (json) {
    const r = normalize(json.value, ctx);
    if (r.notifs.length) {
      result = r;
      const v = json.value as Record<string, unknown>;
      source = PlanV1.safeParse(v).success || v?.format === FORMAT ? 'fais-moi' : 'json';
      if (json.truncated) {
        pre.push({
          code: 'truncated',
          severity: 'warning',
          fixed: true,
          message: 'Your plan looks cut off at the end — the last notif may be missing.',
          fixIt: 'Your last answer was cut off. Send the complete json block again.',
        });
      }
    }
  }

  if (!result) {
    const t = parseText(json ? text.slice(0, json.span[0]) + text.slice(json.span[1]) : text);
    if (t.notifs.length) {
      const { skipped, ...raw } = t;
      result = normalize(raw, { ...ctx, fromText: true });
      source = 'text';
      pre.push({
        code: 'no-json',
        severity: 'info',
        fixed: true,
        message: 'There was no fais-moi code block, so we read the reminders line by line.',
        fixIt: 'Rewrite your last answer as one fais-moi v1 json block.',
      });
      if (skipped) {
        pre.push({ code: 'prose-skipped', severity: 'info', fixed: true, message: 'Intro and outro text skipped.' });
      }
    }
  }

  if (!result) {
    const empty = normalize({}, ctx);
    return {
      status: 'failed',
      source: 'none',
      plan: { ...empty.plan, title: '' },
      notifs: [],
      issues: [
        {
          code: 'no-notifs',
          severity: 'error',
          fixed: false,
          message: text.trim() ? "We couldn't find any notifs with a time and a title." : 'Nothing to read yet.',
          fixIt: 'Rewrite your last answer as one fais-moi v1 json block.',
        },
      ],
    };
  }

  const { plan, notifs } = result;
  const issues = [...pre, ...result.issues];
  checkQuietHours(plan, notifs, issues);
  enforceDailyCap(plan, notifs, issues);

  return {
    status: issues.some((i) => i.severity === 'error') ? 'partial' : 'ok',
    source,
    plan,
    notifs,
    issues,
  };
}

/** Label for the detected-format chip on the Paste screen. */
export function describeSource(source: Source): string {
  return { 'fais-moi': 'fais-moi v1', json: 'JSON', text: 'Text', none: 'Not a plan yet' }[source];
}

/** Notifs whose problems block "Start plan". */
export function blockingIssues(result: Pick<ParseResult, 'issues' | 'notifs'>): Issue[] {
  const enabled = new Set(result.notifs.filter((n) => n.enabled).map((n) => n.id));
  return result.issues.filter((i) => i.severity === 'error' && (!i.notifId || enabled.has(i.notifId)));
}

/** The Nth (1-based) occurrence of a notif uses messages[(N-1) % len]. */
export function messageFor(messages: readonly string[], occurrence: number): string {
  if (!messages.length) return '';
  const i = (((occurrence - 1) % messages.length) + messages.length) % messages.length;
  return messages[i]!;
}

export { buildFixItPrompt, buildPlanPrompt, type PromptInput } from './prompt';
export { serializePlan } from './serialize';
export { describeOn, formatOn, parseOn } from './rules';
export { formatQuiet, formatTime, parseTime } from './time';
export { endDate } from './dates';
export { ICONS, PlanV1, NotifV1, SCHEMA_TEXT, FORMAT, type Icon } from './schema';
export type * from './types';
