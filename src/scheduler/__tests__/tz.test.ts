import { describe, expect, it } from 'vitest';
import { offsetAt, wallClock, zonedTime } from '../tz';

const iso = (t: number) => new Date(t).toISOString();

describe('zonedTime', () => {
  it('converts wall-clock to an instant', () => {
    expect(iso(zonedTime('2026-09-28', '08:00', 'Africa/Lagos'))).toBe('2026-09-28T07:00:00.000Z');
    expect(iso(zonedTime('2026-09-28', '08:00', 'UTC'))).toBe('2026-09-28T08:00:00.000Z');
    expect(iso(zonedTime('2026-09-28', '08:00', 'Asia/Kolkata'))).toBe('2026-09-28T02:30:00.000Z');
  });

  it('keeps 08:00 at 08:00 across a DST change', () => {
    // New York: EDT (UTC−4) until 1 Nov 2026, then EST (UTC−5).
    expect(iso(zonedTime('2026-10-31', '08:00', 'America/New_York'))).toBe('2026-10-31T12:00:00.000Z');
    expect(iso(zonedTime('2026-11-01', '08:00', 'America/New_York'))).toBe('2026-11-01T13:00:00.000Z');
    // London: BST until 25 Oct 2026.
    expect(iso(zonedTime('2026-10-24', '21:00', 'Europe/London'))).toBe('2026-10-24T20:00:00.000Z');
    expect(iso(zonedTime('2026-10-25', '21:00', 'Europe/London'))).toBe('2026-10-25T21:00:00.000Z');
  });

  it('a time skipped by spring-forward moves forward by the gap', () => {
    // 8 Mar 2026, New York jumps 02:00 → 03:00.
    const t = zonedTime('2026-03-08', '02:30', 'America/New_York');
    expect(wallClock(t, 'America/New_York')).toEqual({ date: '2026-03-08', hm: '03:30' });
  });

  it('a time that happens twice at fall-back uses the first', () => {
    // 1 Nov 2026, New York repeats 01:00–02:00.
    const t = zonedTime('2026-11-01', '01:30', 'America/New_York');
    expect(iso(t)).toBe('2026-11-01T05:30:00.000Z');
    expect(offsetAt(t, 'America/New_York')).toBe(-4 * 3_600_000);
  });

  it('handles date lines', () => {
    expect(iso(zonedTime('2026-09-29', '07:00', 'Pacific/Auckland'))).toBe('2026-09-28T18:00:00.000Z');
  });
});
