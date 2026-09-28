import { addDays, endDate, todayIn } from '../parser/dates';
import { clearOsNotificationIds, deletePendingFrom, listOccurrencesBetween, markMissed, setOsNotificationId, upsertOccurrence } from '../db/occurrences';
import { listNotifs } from '../db/notifs';
import { listPlans, refreshPlanStatuses } from '../db/plans';
import { getSettings, updateSettings } from '../db/settings';
import type { Db } from '../db/types';
import { expand } from './expand';
import type { Notifier, OsNotification } from './notifier';
import { NUDGE_AFTER, pickWindow } from './window';
import { zonedTime } from './tz';

/** Days expanded ahead, counting today. 60 slots rarely reach past a week, so 14 is plenty. */
export const HORIZON_DAYS = 14;
/** A pending occurrence becomes missed once its nudge window has passed with no action. */
export const MISSED_AFTER = NUDGE_AFTER;

export interface ReconcileResult {
  /** 'no-permission': nothing scheduled, plans untouched until permission comes back. */
  status: 'scheduled' | 'no-permission';
  scheduled: OsNotification[];
}

export interface ReconcileOptions {
  now?: number;
  deviceTz?: string;
  horizonDays?: number;
}

/**
 * Makes the OS schedule match the database. Idempotent: cancel every fais-moi
 * notification, recompute the window, schedule it again. Run on launch, on
 * foreground, after any edit, after a notification action, and from the
 * background task.
 */
export async function reconcile(db: Db, notifier: Notifier, opts: ReconcileOptions = {}): Promise<ReconcileResult> {
  const now = opts.now ?? Date.now();
  const deviceTz = opts.deviceTz ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const horizonDays = opts.horizonDays ?? HORIZON_DAYS;

  await refreshPlanStatuses(db, now);
  await markMissed(db, now - MISSED_AFTER);
  let settings = await getSettings(db);
  if (settings.pause?.until != null && settings.pause.until <= now) settings = await updateSettings(db, { pause: null });

  if (!(await notifier.canNotify())) {
    await notifier.cancelAll();
    await clearOsNotificationIds(db);
    return { status: 'no-permission', scheduled: [] };
  }

  const plans = (await listPlans(db)).filter((p) => p.status !== 'ended');
  const notifs = (await Promise.all(plans.map((p) => listNotifs(db, p.id)))).flat();
  const candidates = expand({ plans, notifs, settings, now, horizonDays, deviceTz });

  // Bring the stored future in line with the rules: upsert what should fire (keeping
  // any state the user already set, e.g. a future occurrence skipped from Today),
  // then drop pending rows the rules no longer produce.
  let moreAfter: number | null = null;
  await db.withTransactionAsync(async () => {
    const keep: number[] = [];
    for (const c of candidates) {
      const o = await upsertOccurrence(db, { notifId: c.notifId, fireAt: c.fireAt, localDate: c.localDate, messageIndex: c.messageIndex });
      keep.push(o.id);
    }
    await deletePendingFrom(db, now, keep);
  });

  // Plans still running after the expanded days need the app opened again before then.
  for (const p of plans) {
    const lastExpanded = addDays(todayIn(p.tz, now), horizonDays - 1);
    const last = endDate(p.start, p.days);
    if (last === null || last > lastExpanded) {
      const at = zonedTime(addDays(lastExpanded, 1), '00:00', p.tz);
      moreAfter = moreAfter === null ? at : Math.min(moreAfter, at);
    }
  }

  const pending = await listOccurrencesBetween(db, now - NUDGE_AFTER, Number.MAX_SAFE_INTEGER);
  const window = pickWindow(pending, now, { moreAfter });

  await notifier.cancelAll();
  await clearOsNotificationIds(db);
  for (const n of window) {
    const osId = await notifier.schedule(n);
    if ((n.data.kind === 'main' || n.data.kind === 'snooze') && n.id.startsWith('occ-')) {
      await setOsNotificationId(db, Number(n.id.slice(4)), osId);
    }
  }
  return { status: 'scheduled', scheduled: window };
}

/**
 * reconcile() calls triggered close together (foreground + an action) run one
 * after another, never interleaved — each one cancels everything first.
 */
export function serialized<A extends unknown[], R>(fn: (...args: A) => Promise<R>): (...args: A) => Promise<R> {
  let chain: Promise<unknown> = Promise.resolve();
  return (...args: A) => {
    const run = chain.then(() => fn(...args));
    chain = run.catch(() => undefined);
    return run;
  };
}
