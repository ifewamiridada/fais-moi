import { slug } from '../parser/normalize';
import type { Icon } from '../parser/schema';
import type { NotifDraft } from '../parser/types';
import * as check from './check';
import { ValidationError, type Db, type Notif } from './types';

interface NotifRow {
  id: number;
  plan_id: number;
  key: string;
  title: string;
  icon: string;
  at: string | null;
  on_rule: string;
  messages_json: string;
  priority: Notif['priority'];
  optional: number;
  on_miss: Notif['onMiss'];
  enabled: number;
  sort: number;
}

export function toNotif(r: NotifRow): Notif {
  return {
    id: r.id,
    planId: r.plan_id,
    key: r.key,
    title: r.title,
    icon: r.icon as Icon,
    at: r.at,
    on: r.on_rule,
    messages: JSON.parse(r.messages_json) as string[],
    priority: r.priority,
    optional: r.optional === 1,
    onMiss: r.on_miss,
    enabled: r.enabled === 1,
    sort: r.sort,
  };
}

/** Back to the parser's shape, e.g. for serializePlan() in "Adjust with ChatGPT". */
export function toNotifDraft(n: Notif): NotifDraft {
  const { id: _id, planId: _planId, sort: _sort, key, ...rest } = n;
  return { ...rest, id: key };
}

/** Checks a notif before it is stored. Enabled notifs must be schedulable. */
function checked(n: Omit<NotifDraft, 'id'>): Omit<NotifDraft, 'id'> {
  const out = {
    ...n,
    title: check.nonEmpty(n.title, 'title'),
    icon: check.icon(n.icon) as Icon,
    at: n.at === null ? null : check.hm(n.at, 'at'),
    on: check.onRule(n.on),
    priority: check.oneOf(n.priority, ['silent', 'gentle', 'critical'] as const, 'priority'),
    onMiss: check.oneOf(n.onMiss, ['none', 'nudge_once'] as const, 'onMiss'),
    messages: n.enabled ? check.messages(n.messages) : n.messages.map((m) => m.trim()).filter(Boolean),
  };
  if (out.enabled && out.at === null) throw new ValidationError(`“${out.title}” needs a time before it can be on`);
  return out;
}

/** Inserts without a transaction; callers (createPlan, addNotif) own that. */
export async function insertNotif(db: Db, planId: number, draft: NotifDraft, sort: number): Promise<number> {
  const n = checked(draft);
  const key = await freeKey(db, planId, slug(draft.id) || slug(n.title) || 'notif');
  const r = await db.runAsync(
    `INSERT INTO notif (plan_id, key, title, icon, at, on_rule, messages_json, priority, optional, on_miss, enabled, sort)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      planId,
      key,
      n.title,
      n.icon,
      n.at,
      n.on,
      JSON.stringify(n.messages),
      n.priority,
      n.optional ? 1 : 0,
      n.onMiss,
      n.enabled ? 1 : 0,
      sort,
    ],
  );
  return r.lastInsertRowId;
}

async function freeKey(db: Db, planId: number, base: string): Promise<string> {
  const taken = new Set(
    (await db.getAllAsync<{ key: string }>('SELECT key FROM notif WHERE plan_id = ?', [planId])).map((r) => r.key),
  );
  if (!taken.has(base)) return base;
  let i = 2;
  while (taken.has(`${base}-${i}`)) i++;
  return `${base}-${i}`;
}

export async function listNotifs(db: Db, planId: number): Promise<Notif[]> {
  const rows = await db.getAllAsync<NotifRow>('SELECT * FROM notif WHERE plan_id = ? ORDER BY sort, id', [planId]);
  return rows.map(toNotif);
}

export async function getNotif(db: Db, id: number): Promise<Notif | null> {
  const row = await db.getFirstAsync<NotifRow>('SELECT * FROM notif WHERE id = ?', [id]);
  return row ? toNotif(row) : null;
}

/** Adds a notif at the end of a plan (Edit notif → "Add"). */
export async function addNotif(db: Db, planId: number, draft: NotifDraft): Promise<Notif> {
  let id = 0;
  await db.withTransactionAsync(async () => {
    const last = await db.getFirstAsync<{ s: number | null }>('SELECT MAX(sort) AS s FROM notif WHERE plan_id = ?', [planId]);
    id = await insertNotif(db, planId, draft, (last?.s ?? -1) + 1);
  });
  return (await getNotif(db, id))!;
}

export type NotifPatch = Partial<
  Pick<Notif, 'title' | 'icon' | 'at' | 'on' | 'priority' | 'optional' | 'onMiss' | 'enabled' | 'messages' | 'sort'>
>;

/** Edit notif sheet. The merged result is validated as a whole, so turning on a notif with no time fails. */
export async function updateNotif(db: Db, id: number, patch: NotifPatch): Promise<Notif> {
  const current = await getNotif(db, id);
  if (!current) throw new ValidationError(`No notif ${id}`);
  const next = checked({ ...current, ...patch });
  const sort = patch.sort ?? current.sort;
  await db.runAsync(
    `UPDATE notif SET title = ?, icon = ?, at = ?, on_rule = ?, messages_json = ?, priority = ?,
       optional = ?, on_miss = ?, enabled = ?, sort = ? WHERE id = ?`,
    [
      next.title,
      next.icon,
      next.at,
      next.on,
      JSON.stringify(next.messages),
      next.priority,
      next.optional ? 1 : 0,
      next.onMiss,
      next.enabled ? 1 : 0,
      sort,
      id,
    ],
  );
  return (await getNotif(db, id))!;
}

/** Plan screen → "Missed a notif": applies to every notif in the plan. */
export async function setPlanOnMiss(db: Db, planId: number, onMiss: Notif['onMiss']): Promise<void> {
  await db.runAsync('UPDATE notif SET on_miss = ? WHERE plan_id = ?', [
    check.oneOf(onMiss, ['none', 'nudge_once'] as const, 'onMiss'),
    planId,
  ]);
}

export async function deleteNotif(db: Db, id: number): Promise<void> {
  await db.runAsync('DELETE FROM notif WHERE id = ?', [id]);
}
