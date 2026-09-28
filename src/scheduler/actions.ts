import { addSnooze, getOccurrence, setOccurrenceState } from '../db/occurrences';
import type { Db, OccurrenceState } from '../db/types';
import { ACTION, type NotificationData } from './notifier';
import { SNOOZE_FOR } from './window';

export type ActionOutcome = 'done' | 'snoozed' | 'skipped' | 'opened' | 'ignored';

/**
 * Applies a notification response to the database; the caller runs reconcile()
 * afterwards. The same response can arrive twice (listener and
 * getLastNotificationResponse), so a response for a row that was already acted on
 * is ignored.
 *
 * Done and Skip resolve the main occurrence and any snooze still waiting for it.
 * In 30 min marks the row that fired as snoozed and adds a snooze row 30 minutes on.
 */
export async function handleAction(
  db: Db,
  actionId: string,
  data: Partial<NotificationData> | undefined,
  now: number = Date.now(),
): Promise<ActionOutcome> {
  if (!data?.occurrenceId || data.kind === 'keepalive') return 'opened';
  const main = await getOccurrence(db, data.occurrenceId);
  if (!main || main.kind !== 'main') return 'ignored';
  const source = data.sourceId && data.sourceId !== main.id ? await getOccurrence(db, data.sourceId) : main;
  if (!source) return 'ignored';

  const resolve = async (state: OccurrenceState) => {
    if (main.state === state) return false;
    await setOccurrenceState(db, main.id, state, now);
    for (const id of await pendingSnoozes(db, main.id)) await setOccurrenceState(db, id, state, now);
    return true;
  };

  switch (actionId) {
    case ACTION.done:
      return (await resolve('done')) ? 'done' : 'ignored';
    case ACTION.skip:
      return (await resolve('skipped')) ? 'skipped' : 'ignored';
    case ACTION.snooze:
      // Snoozing is only valid from a row still waiting for an answer.
      if (source.kind === 'snooze' ? source.state !== 'pending' : main.state !== 'pending') return 'ignored';
      await setOccurrenceState(db, source.id, 'snoozed', now);
      if (source !== main) await setOccurrenceState(db, main.id, 'snoozed', now);
      await addSnooze(db, main, now + SNOOZE_FOR);
      return 'snoozed';
    default:
      // Tapping the notification itself just opens the app.
      return 'opened';
  }
}

async function pendingSnoozes(db: Db, mainId: number): Promise<number[]> {
  const rows = await db.getAllAsync<{ id: number }>(
    `SELECT id FROM occurrence WHERE parent_id = ? AND kind = 'snooze' AND state = 'pending'`,
    [mainId],
  );
  return rows.map((r) => r.id);
}
