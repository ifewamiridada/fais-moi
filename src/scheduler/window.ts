import type { OccurrenceView } from '../db/occurrences';
import type { OsNotification } from './notifier';

/** iOS keeps at most 64 pending local notifications per app. */
export const OS_LIMIT = 64;
/** Occurrences (and nudges) scheduled with the OS; the rest of the limit is headroom. */
export const MAX_SCHEDULED = 60;
export const NUDGE_AFTER = 30 * 60_000;
export const SNOOZE_FOR = 30 * 60_000;

export const KEEPALIVE_BODY = 'Open fais-moi to keep your plans running.';

function fromOccurrence(o: OccurrenceView): OsNotification {
  return {
    id: `occ-${o.id}`,
    fireAt: o.fireAt,
    title: o.title,
    subtitle: o.planTitle,
    body: o.message,
    priority: o.priority,
    withActions: true,
    data: { kind: o.kind, occurrenceId: o.kind === 'snooze' ? o.parentId! : o.id, sourceId: o.id },
  };
}

function nudgeFor(o: OccurrenceView): OsNotification {
  return {
    id: `nudge-${o.id}`,
    fireAt: o.fireAt + NUDGE_AFTER,
    title: o.title,
    subtitle: o.planTitle,
    body: o.message,
    priority: o.priority,
    withActions: true,
    data: { kind: 'nudge', occurrenceId: o.id, sourceId: o.id },
  };
}

/**
 * Picks what to hand the OS: pending occurrences (and their one nudge, for
 * on_miss = nudge_once) after `now`, soonest first, at most MAX_SCHEDULED. When
 * anything is left over — or plans run past the expanded days — one more
 * notification after the last asks the user to open the app, so the rolling
 * window gets refilled. That makes at most MAX_SCHEDULED + 1 ≤ OS_LIMIT.
 *
 * `occurrences` may include recent past pending ones: their nudge can still be due.
 */
export function pickWindow(
  occurrences: OccurrenceView[],
  now: number,
  opts: { moreAfter: number | null; max?: number },
): OsNotification[] {
  const max = opts.max ?? MAX_SCHEDULED;
  const items: OsNotification[] = [];
  for (const o of occurrences) {
    if (o.state !== 'pending') continue;
    if (o.fireAt > now) items.push(fromOccurrence(o));
    if (o.kind === 'main' && o.onMiss === 'nudge_once' && o.fireAt + NUDGE_AFTER > now) items.push(nudgeFor(o));
  }
  items.sort((a, b) => a.fireAt - b.fireAt || a.id.localeCompare(b.id));
  const picked = items.slice(0, max);
  const truncated = items.length > picked.length;

  if (truncated || opts.moreAfter !== null) {
    const lastAt = picked.length ? picked[picked.length - 1]!.fireAt : now;
    picked.push({
      id: 'keepalive',
      // Just after the last scheduled one — or, when nothing is due before the
      // expanded days run out, when they do.
      fireAt: Math.max(lastAt + 60_000, truncated ? 0 : (opts.moreAfter ?? 0)),
      title: 'fais-moi.',
      body: KEEPALIVE_BODY,
      priority: 'gentle',
      withActions: false,
      data: { kind: 'keepalive' },
    });
  }
  return picked;
}
