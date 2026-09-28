import { endDate, todayIn } from '../parser/dates';
import type { NotifDraft, PlanDraft } from '../parser/types';
import * as check from './check';
import { insertNotif, listNotifs, toNotifDraft } from './notifs';
import { ValidationError, type Db, type Plan, type PlanStatus } from './types';

interface PlanRow {
  id: number;
  title: string;
  start_date: string;
  days: number | null;
  tz: string;
  per_day: number;
  quiet_start: string;
  quiet_end: string;
  weekend_start: string | null;
  status: PlanStatus;
  paused_until: number | null;
  quiet_until: number | null;
  skipped_date: string | null;
  created_at: number;
}

function toPlan(r: PlanRow): Plan {
  return {
    id: r.id,
    title: r.title,
    start: r.start_date,
    days: r.days,
    tz: r.tz,
    perDay: r.per_day,
    quiet: { start: r.quiet_start, end: r.quiet_end },
    weekendStart: r.weekend_start,
    status: r.status,
    pausedUntil: r.paused_until,
    quietUntil: r.quiet_until,
    skippedDate: r.skipped_date,
    createdAt: r.created_at,
  };
}

function checkedDraft(p: PlanDraft): PlanDraft {
  return {
    title: check.nonEmpty(p.title, 'title'),
    start: check.isoDate(p.start, 'start'),
    days: p.days === null ? null : check.positiveInt(p.days, 'days'),
    tz: check.tz(p.tz),
    perDay: check.positiveInt(p.perDay, 'perDay', 50),
    quiet: check.quiet(p.quiet),
  };
}

/**
 * Review → "Start plan". Stores the plan and every notif (disabled ones too, so
 * they can be switched on later) in one transaction. Enabled notifs must have a
 * time and at least one message — the parser's blocking issues.
 */
export async function createPlan(
  db: Db,
  draft: PlanDraft,
  notifs: NotifDraft[],
  now: number = Date.now(),
): Promise<Plan> {
  const p = checkedDraft(draft);
  if (!notifs.some((n) => n.enabled)) throw new ValidationError('A plan needs at least one notif switched on');
  let id = 0;
  await db.withTransactionAsync(async () => {
    const r = await db.runAsync(
      `INSERT INTO plan (title, start_date, days, tz, per_day, quiet_start, quiet_end, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
      [p.title, p.start, p.days, p.tz, p.perDay, p.quiet.start, p.quiet.end, now],
    );
    id = r.lastInsertRowId;
    for (const [i, n] of notifs.entries()) await insertNotif(db, id, n, i);
  });
  return (await getPlan(db, id))!;
}

export async function getPlan(db: Db, id: number): Promise<Plan | null> {
  const row = await db.getFirstAsync<PlanRow>('SELECT * FROM plan WHERE id = ?', [id]);
  return row ? toPlan(row) : null;
}

/** Plans tab sections: running, paused, finished. Newest first within a status. */
export async function listPlans(db: Db, status?: PlanStatus): Promise<Plan[]> {
  const rows = status
    ? await db.getAllAsync<PlanRow>('SELECT * FROM plan WHERE status = ? ORDER BY created_at DESC, id DESC', [status])
    : await db.getAllAsync<PlanRow>('SELECT * FROM plan ORDER BY created_at DESC, id DESC', []);
  return rows.map(toPlan);
}

export type PlanPatch = Partial<Pick<Plan, 'title' | 'start' | 'days' | 'tz' | 'perDay' | 'quiet' | 'weekendStart'>>;

/** Plan screen settings: most a day, quiet hours, weekends… */
export async function updatePlan(db: Db, id: number, patch: PlanPatch): Promise<Plan> {
  const current = await getPlan(db, id);
  if (!current) throw new ValidationError(`No plan ${id}`);
  const p = checkedDraft({ ...current, ...patch });
  const weekendStart = 'weekendStart' in patch ? patch.weekendStart ?? null : current.weekendStart;
  await db.runAsync(
    `UPDATE plan SET title = ?, start_date = ?, days = ?, tz = ?, per_day = ?, quiet_start = ?, quiet_end = ?,
       weekend_start = ? WHERE id = ?`,
    [
      p.title,
      p.start,
      p.days,
      p.tz,
      p.perDay,
      p.quiet.start,
      p.quiet.end,
      weekendStart === null ? null : check.hm(weekendStart, 'weekendStart'),
      id,
    ],
  );
  return (await getPlan(db, id))!;
}

/** "Pause plan". `until: null` = until the user resumes. */
export async function pausePlan(db: Db, id: number, until: number | null = null): Promise<void> {
  await db.runAsync(`UPDATE plan SET status = 'paused', paused_until = ? WHERE id = ? AND status != 'ended'`, [until, id]);
}

export async function resumePlan(db: Db, id: number): Promise<void> {
  await db.runAsync(`UPDATE plan SET status = 'active', paused_until = NULL WHERE id = ? AND status = 'paused'`, [id]);
}

/** "Quiet till…" on one plan. null clears it. */
export async function setPlanQuietUntil(db: Db, id: number, until: number | null): Promise<void> {
  await db.runAsync('UPDATE plan SET quiet_until = ? WHERE id = ?', [until, id]);
}

/** "Skip today": `date` is today in the plan's tz. null un-skips. */
export async function setPlanSkippedDate(db: Db, id: number, date: string | null): Promise<void> {
  await db.runAsync('UPDATE plan SET skipped_date = ? WHERE id = ?', [date === null ? null : check.isoDate(date, 'date'), id]);
}

export async function endPlan(db: Db, id: number): Promise<void> {
  await db.runAsync(`UPDATE plan SET status = 'ended', paused_until = NULL WHERE id = ?`, [id]);
}

export async function deletePlan(db: Db, id: number): Promise<void> {
  await db.runAsync('DELETE FROM plan WHERE id = ?', [id]);
}

/**
 * Housekeeping before every reconcile(): resume plans whose pause ran out, end plans
 * past their last day (in their own tz), and clear expired quiet/skip markers.
 * Returns the ids of plans whose status changed.
 */
export async function refreshPlanStatuses(db: Db, now: number = Date.now()): Promise<number[]> {
  const changed: number[] = [];
  await db.withTransactionAsync(async () => {
    for (const p of await listPlans(db)) {
      const today = todayIn(p.tz, now);
      const last = endDate(p.start, p.days);
      if (p.status !== 'ended' && last && today > last) {
        await endPlan(db, p.id);
        changed.push(p.id);
        continue;
      }
      if (p.status === 'paused' && p.pausedUntil !== null && p.pausedUntil <= now) {
        await resumePlan(db, p.id);
        changed.push(p.id);
      }
      if (p.quietUntil !== null && p.quietUntil <= now) await setPlanQuietUntil(db, p.id, null);
      if (p.skippedDate !== null && p.skippedDate < today) await setPlanSkippedDate(db, p.id, null);
    }
  });
  return changed;
}

/** Plans tab → Finished → "Run again": a fresh copy of the plan and its notifs from `start`. */
export async function duplicatePlan(db: Db, id: number, start: string, now: number = Date.now()): Promise<Plan> {
  const src = await getPlan(db, id);
  if (!src) throw new ValidationError(`No plan ${id}`);
  const notifs = await listNotifs(db, id);
  const copy = await createPlan(db, { ...src, start: check.isoDate(start, 'start') }, notifs.map(toNotifDraft), now);
  if (src.weekendStart) return updatePlan(db, copy.id, { weekendStart: src.weekendStart });
  return copy;
}

/** Plan + notifs in the parser's shapes, for serializePlan() ("Adjust with ChatGPT"). */
export async function loadPlanDraft(db: Db, id: number): Promise<{ plan: PlanDraft; notifs: NotifDraft[] } | null> {
  const p = await getPlan(db, id);
  if (!p) return null;
  const { title, start, days, tz, perDay, quiet } = p;
  return { plan: { title, start, days, tz, perDay, quiet }, notifs: (await listNotifs(db, id)).map(toNotifDraft) };
}

/** "Day 12 of 30" — null before the start. Ongoing plans count up with no end. */
export function planDay(plan: Pick<Plan, 'start' | 'tz'>, now: number = Date.now()): number | null {
  const today = todayIn(plan.tz, now);
  if (today < plan.start) return null;
  // Calendar-date difference, so DST changes can't shift it.
  return 1 + Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${plan.start}T00:00:00Z`)) / 86_400_000);
}

