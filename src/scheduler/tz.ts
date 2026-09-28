import type { HM } from '../parser/types';

const MINUTE = 60_000;
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
    formatters.set(tz, f);
  }
  return f;
}

/** Wall-clock date and time in `tz` at instant `t`. */
export function wallClock(t: number, tz: string): { date: string; hm: HM } {
  const p: Record<string, string> = {};
  for (const part of formatter(tz).formatToParts(t)) p[part.type] = part.value;
  const hour = p.hour === '24' ? '00' : p.hour;
  return { date: `${p.year}-${p.month}-${p.day}`, hm: `${hour}:${p.minute}` };
}

/** UTC offset of `tz` at instant `t`, in ms (Lagos → +3 600 000). */
export function offsetAt(t: number, tz: string): number {
  const { date, hm } = wallClock(t, tz);
  const [y, mo, d] = date.split('-').map(Number);
  const [h, mi] = hm.split(':').map(Number);
  const asUtc = Date.UTC(y!, mo! - 1, d!, h!, mi!);
  return asUtc - Math.floor(t / MINUTE) * MINUTE;
}

/**
 * The instant a wall-clock time happens in `tz`, DST-aware:
 * - a time that happens twice (clocks go back) → the first one;
 * - a time that never happens (clocks go forward) → moved forward by the gap
 *   (02:30 on a spring-forward night fires at 03:30).
 */
export function zonedTime(date: string, hm: HM, tz: string): number {
  const [y, mo, d] = date.split('-').map(Number);
  const [h, mi] = hm.split(':').map(Number);
  const guess = Date.UTC(y!, mo! - 1, d!, h!, mi!);
  const before = offsetAt(guess - 12 * 60 * MINUTE, tz);
  const after = offsetAt(guess + 12 * 60 * MINUTE, tz);
  const hits = [guess - before, guess - after]
    .filter((t) => {
      const w = wallClock(t, tz);
      return w.date === date && w.hm === hm;
    })
    .sort((a, b) => a - b);
  return hits[0] ?? guess - before;
}
