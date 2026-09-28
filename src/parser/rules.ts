import { formatDate, parseIsoDate, weekdayIndex } from './dates';

export const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export type OnRule = { kind: 'weekly'; days: Weekday[] } | { kind: 'date'; date: string };

const DAY_NAMES: Record<string, Weekday> = {
  mon: 'mon', monday: 'mon',
  tue: 'tue', tues: 'tue', tuesday: 'tue',
  wed: 'wed', weds: 'wed', wednesday: 'wed',
  thu: 'thu', thur: 'thu', thurs: 'thu', thursday: 'thu',
  fri: 'fri', friday: 'fri',
  sat: 'sat', saturday: 'sat',
  sun: 'sun', sunday: 'sun',
};

const ALL = [...WEEKDAYS];
const WORK: Weekday[] = ['mon', 'tue', 'wed', 'thu', 'fri'];
const WEEKEND: Weekday[] = ['sat', 'sun'];

function dayName(token: string): Weekday | null {
  const t = token.replace(/\.$/, '');
  return DAY_NAMES[t] ?? DAY_NAMES[t.replace(/s$/, '')] ?? null;
}

function sortDays(days: Iterable<Weekday>): Weekday[] {
  const set = new Set(days);
  return WEEKDAYS.filter((d) => set.has(d));
}

/**
 * Lenient reader for `on`. Accepts the canonical forms plus things ChatGPT writes:
 * "every day", "Mon–Fri", "Saturdays", "every Saturday", "mon & thu", ["mon","wed"].
 */
export function parseOn(input: unknown): OnRule | null {
  if (Array.isArray(input)) {
    const days = input.map((x) => (typeof x === 'string' ? dayName(x.trim().toLowerCase()) : null));
    if (!days.length || days.some((d) => !d)) return null;
    return { kind: 'weekly', days: sortDays(days as Weekday[]) };
  }
  if (typeof input !== 'string') return null;
  const date = parseIsoDate(input);
  if (date) return { kind: 'date', date };

  let s = input.trim().toLowerCase().replace(/[–—]/g, '-');
  s = s.replace(/\b(every|each|on|only|repeat|repeats)\b/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s) return null;
  if (/^(daily|day|everyday|all days|all week|7 days)$/.test(s)) return { kind: 'weekly', days: ALL };
  if (/^(weekdays?|workdays?|work days|mon ?- ?fri|monday ?- ?friday|monday to friday|mon to fri)$/.test(s))
    return { kind: 'weekly', days: WORK };
  if (/^(weekends?|sat ?- ?sun|saturday ?- ?sunday|sat(urday)?s? (and|&) sun(day)?s?)$/.test(s))
    return { kind: 'weekly', days: WEEKEND };

  const days = new Set<Weekday>();
  for (const token of s.split(/\s*(?:,|\/|&|\+|\band\b|\s)\s*/).filter(Boolean)) {
    const range = /^([a-z]+)-([a-z]+)$/.exec(token);
    if (range) {
      const a = dayName(range[1]!);
      const b = dayName(range[2]!);
      if (!a || !b) return null;
      let i = WEEKDAYS.indexOf(a);
      for (;;) {
        days.add(WEEKDAYS[i]!);
        if (WEEKDAYS[i] === b) break;
        i = (i + 1) % 7;
      }
      continue;
    }
    const d = dayName(token);
    if (!d) return null;
    days.add(d);
  }
  return days.size ? { kind: 'weekly', days: sortDays(days) } : null;
}

/** Canonical string stored in `notif.on_rule`. */
export function formatOn(rule: OnRule): string {
  if (rule.kind === 'date') return rule.date;
  const key = rule.days.join(',');
  if (key === ALL.join(',')) return 'daily';
  if (key === WORK.join(',')) return 'weekdays';
  if (key === WEEKEND.join(',')) return 'weekends';
  return key;
}

const LONG: Record<Weekday, string> = {
  mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday',
};
const SHORT: Record<Weekday, string> = {
  mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun',
};

/** Human label for Review: "Daily", "Weekdays", "Saturdays", "Mon, Wed & Fri", "3 Oct". */
export function describeOn(rule: OnRule | string): string {
  const r = typeof rule === 'string' ? parseOn(rule) : rule;
  if (!r) return String(rule);
  if (r.kind === 'date') return formatDate(r.date);
  const canon = formatOn(r);
  if (canon === 'daily') return 'Daily';
  if (canon === 'weekdays') return 'Weekdays';
  if (canon === 'weekends') return 'Weekends';
  return listDays(r.days);
}

/** "Saturdays", "Saturdays & Sundays", "Mon, Wed & Fri". */
export function listDays(days: Weekday[]): string {
  if (days.length === 1) return `${LONG[days[0]!]}s`;
  const names = days.map((d) => (days.length === 2 ? `${LONG[d]}s` : SHORT[d]));
  return `${names.slice(0, -1).join(', ')} & ${names[names.length - 1]}`;
}

export function firesOn(rule: OnRule, isoDate: string): boolean {
  if (rule.kind === 'date') return rule.date === isoDate;
  return rule.days.includes(WEEKDAYS[weekdayIndex(isoDate)]!);
}
