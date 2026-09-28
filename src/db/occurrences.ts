import type { Icon } from '../parser/schema';
import * as check from './check';
import { ValidationError, type Db, type Occurrence, type OccurrenceState } from './types';

interface OccurrenceRow {
  id: number;
  notif_id: number;
  fire_at: number;
  local_date: string;
  message_index: number;
  os_notification_id: string | null;
  state: OccurrenceState;
  acted_at: number | null;
}

const toOccurrence = (r: OccurrenceRow): Occurrence => ({
  id: r.id,
  notifId: r.notif_id,
  fireAt: r.fire_at,
  localDate: r.local_date,
  messageIndex: r.message_index,
  osNotificationId: r.os_notification_id,
  state: r.state,
  actedAt: r.acted_at,
});

/** An occurrence with what Today and the OS notification need to show it. */
export interface OccurrenceView extends Occurrence {
  planId: number;
  planTitle: string;
  title: string;
  icon: Icon;
  priority: 'silent' | 'gentle' | 'critical';
  /** messages[messageIndex % messages.length] */
  message: string;
}

const VIEW = `
  SELECT o.*, n.plan_id, n.title, n.icon, n.priority, n.messages_json, p.title AS plan_title
  FROM occurrence o
  JOIN notif n ON n.id = o.notif_id
  JOIN plan p ON p.id = n.plan_id`;

type ViewRow = OccurrenceRow & {
  plan_id: number;
  plan_title: string;
  title: string;
  icon: Icon;
  priority: OccurrenceView['priority'];
  messages_json: string;
};

function toView(r: ViewRow): OccurrenceView {
  const messages = JSON.parse(r.messages_json) as string[];
  return {
    ...toOccurrence(r),
    planId: r.plan_id,
    planTitle: r.plan_title,
    title: r.title,
    icon: r.icon,
    priority: r.priority,
    message: messages.length ? messages[r.message_index % messages.length]! : '',
  };
}

export interface NewOccurrence {
  notifId: number;
  fireAt: number;
  localDate: string;
  messageIndex: number;
}

/**
 * Idempotent: one row per (notif, fire time). Re-running reconcile() over the same
 * window keeps existing rows — and their state — and only refreshes the message index.
 */
export async function upsertOccurrence(db: Db, o: NewOccurrence): Promise<Occurrence> {
  check.isoDate(o.localDate, 'localDate');
  await db.runAsync(
    `INSERT INTO occurrence (notif_id, fire_at, local_date, message_index) VALUES (?, ?, ?, ?)
     ON CONFLICT (notif_id, fire_at) DO UPDATE SET message_index = excluded.message_index, local_date = excluded.local_date`,
    [o.notifId, o.fireAt, o.localDate, o.messageIndex],
  );
  const row = await db.getFirstAsync<OccurrenceRow>('SELECT * FROM occurrence WHERE notif_id = ? AND fire_at = ?', [
    o.notifId,
    o.fireAt,
  ]);
  return toOccurrence(row!);
}

export async function getOccurrence(db: Db, id: number): Promise<OccurrenceView | null> {
  const row = await db.getFirstAsync<ViewRow>(`${VIEW} WHERE o.id = ?`, [id]);
  return row ? toView(row) : null;
}

/** Everything in [from, to), soonest first — the scheduler's window. */
export async function listOccurrencesBetween(db: Db, from: number, to: number): Promise<OccurrenceView[]> {
  const rows = await db.getAllAsync<ViewRow>(`${VIEW} WHERE o.fire_at >= ? AND o.fire_at < ? ORDER BY o.fire_at, o.id`, [
    from,
    to,
  ]);
  return rows.map(toView);
}

/** Today's timeline across plans (done ones included, for fading). */
export async function listOccurrencesOn(db: Db, localDate: string): Promise<OccurrenceView[]> {
  const rows = await db.getAllAsync<ViewRow>(`${VIEW} WHERE o.local_date = ? ORDER BY o.fire_at, o.id`, [
    check.isoDate(localDate, 'localDate'),
  ]);
  return rows.map(toView);
}

/** Done / In 30 min / Skip today, from the notification or the app. */
export async function setOccurrenceState(
  db: Db,
  id: number,
  state: OccurrenceState,
  actedAt: number | null = Date.now(),
): Promise<void> {
  check.oneOf(state, ['pending', 'done', 'snoozed', 'skipped', 'missed'] as const, 'state');
  const r = await db.runAsync('UPDATE occurrence SET state = ?, acted_at = ? WHERE id = ?', [
    state,
    state === 'pending' ? null : actedAt,
    id,
  ]);
  if (!r.changes) throw new ValidationError(`No occurrence ${id}`);
}

export async function setOsNotificationId(db: Db, id: number, osId: string | null): Promise<void> {
  await db.runAsync('UPDATE occurrence SET os_notification_id = ? WHERE id = ?', [osId, id]);
}

/** After cancelling every OS notification: nothing is scheduled any more. */
export async function clearOsNotificationIds(db: Db): Promise<void> {
  await db.runAsync('UPDATE occurrence SET os_notification_id = NULL WHERE os_notification_id IS NOT NULL');
}

/** Pending occurrences that fired before `before` with no action become missed. Returns how many. */
export async function markMissed(db: Db, before: number): Promise<number> {
  const r = await db.runAsync(`UPDATE occurrence SET state = 'missed' WHERE state = 'pending' AND fire_at < ?`, [before]);
  return r.changes;
}

/**
 * Drops future occurrences nobody has acted on, so reconcile() can rebuild the
 * window after an edit (a changed time or a disabled notif leaves no stale rows).
 */
export async function deletePendingFrom(db: Db, from: number): Promise<number> {
  const r = await db.runAsync(`DELETE FROM occurrence WHERE state = 'pending' AND fire_at >= ?`, [from]);
  return r.changes;
}

export interface Tally {
  done: number;
  snoozed: number;
  skipped: number;
  missed: number;
}

export interface History {
  byNotif: Array<Tally & { notifId: number; title: string }>;
  byDay: Array<Tally & { date: string }>;
  total: Tally;
}

const TALLY = `
  SUM(o.state = 'done') AS done, SUM(o.state = 'snoozed') AS snoozed,
  SUM(o.state = 'skipped') AS skipped, SUM(o.state = 'missed') AS missed`;

/**
 * Outcomes for a plan between two plan-local dates (inclusive): the Plan screen's
 * "Last 7 days" strip, and the history sent with "Adjust with ChatGPT".
 */
export async function planHistory(db: Db, planId: number, fromDate: string, toDate: string): Promise<History> {
  const range = [planId, check.isoDate(fromDate, 'fromDate'), check.isoDate(toDate, 'toDate')];
  const where = 'FROM occurrence o JOIN notif n ON n.id = o.notif_id WHERE n.plan_id = ? AND o.local_date BETWEEN ? AND ?';
  const num = (t: Record<string, unknown>): Tally => ({
    done: Number(t.done ?? 0),
    snoozed: Number(t.snoozed ?? 0),
    skipped: Number(t.skipped ?? 0),
    missed: Number(t.missed ?? 0),
  });
  const byNotif = await db.getAllAsync<Record<string, unknown>>(
    `SELECT n.id AS notif_id, n.title, ${TALLY} ${where} GROUP BY n.id ORDER BY n.sort, n.id`,
    range,
  );
  const byDay = await db.getAllAsync<Record<string, unknown>>(
    `SELECT o.local_date, ${TALLY} ${where} GROUP BY o.local_date ORDER BY o.local_date`,
    range,
  );
  const total = byNotif.map(num).reduce(
    (a, b) => ({ done: a.done + b.done, snoozed: a.snoozed + b.snoozed, skipped: a.skipped + b.skipped, missed: a.missed + b.missed }),
    { done: 0, snoozed: 0, skipped: 0, missed: 0 },
  );
  return {
    byNotif: byNotif.map((r) => ({ notifId: Number(r.notif_id), title: String(r.title), ...num(r) })),
    byDay: byDay.map((r) => ({ date: String(r.local_date), ...num(r) })),
    total,
  };
}
