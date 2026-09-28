import type { HM, QuietHours } from './types';

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * Lenient time reader: "08:00", "8:00 AM", "8am", "20.30", "8h30", "noon".
 * A bare number ("8") is ambiguous and rejected.
 */
export function parseTime(input: unknown): HM | null {
  if (typeof input !== 'string') return null;
  const s = input.trim().toLowerCase().replace(/\s+/g, ' ');
  if (s === 'noon' || s === 'midday') return '12:00';
  if (s === 'midnight') return '00:00';
  const m = /^(\d{1,2})(?:\s*[:.h]\s*(\d{2})(?::\d{2})?)?\s*(a\.?\s?m\.?|p\.?\s?m\.?)?$/.exec(s);
  if (!m) return null;
  let h = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  const ampm = m[3]?.[0];
  if (!m[2] && !ampm) return null;
  if (min > 59) return null;
  if (ampm) {
    if (h < 1 || h > 12) return null;
    if (ampm === 'a') h = h === 12 ? 0 : h;
    else h = h === 12 ? 12 : h + 12;
  } else if (h > 23) return null;
  return `${pad(h)}:${pad(min)}`;
}

export function toMinutes(hm: HM): number {
  const [h, m] = hm.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/** True when `t` falls in [start, end), including windows that cross midnight. */
export function inWindow(t: HM, { start, end }: QuietHours): boolean {
  const x = toMinutes(t);
  const a = toMinutes(start);
  const b = toMinutes(end);
  if (a === b) return false;
  return a < b ? x >= a && x < b : x >= a || x < b;
}

/** "22:30-06:30", "10:30 PM – 6:30 AM", or { start, end } / { from, to }. */
export function parseQuiet(input: unknown): QuietHours | null {
  if (input && typeof input === 'object') {
    const o = input as Record<string, unknown>;
    const start = parseTime(o.start ?? o.from);
    const end = parseTime(o.end ?? o.to ?? o.until);
    return start && end ? { start, end } : null;
  }
  if (typeof input !== 'string') return null;
  const parts = input.split(/\s*(?:[-–—]|to|until)\s*/i).filter(Boolean);
  if (parts.length !== 2) return null;
  const start = parseTime(parts[0]);
  const end = parseTime(parts[1]);
  return start && end ? { start, end } : null;
}

/** "08:00" → "8:00 AM". */
export function formatTime(hm: HM): string {
  const [h = 0, m = 0] = hm.split(':').map(Number);
  const suffix = h < 12 ? 'AM' : 'PM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${pad(m)} ${suffix}`;
}

export function formatQuiet(q: QuietHours): string {
  return `${formatTime(q.start)} – ${formatTime(q.end)}`;
}
