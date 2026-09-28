import * as Notifications from 'expo-notifications';
import * as SQLite from 'expo-sqlite';
import { migrate } from '../db/schema';
import type { Db } from '../db/types';
import { expoNotifier } from '../notify/expo';
import { handleAction } from '../scheduler/actions';
import { reconcile, serialized, type ReconcileResult } from '../scheduler/reconcile';

let dbPromise: Promise<Db> | null = null;

/** The one app database, migrated before first use. */
export function getDb(): Promise<Db> {
  if (!dbPromise) {
    dbPromise = (async () => {
      const db: Db = await SQLite.openDatabaseAsync('fais-moi.db');
      await migrate(db);
      return db;
    })();
  }
  return dbPromise;
}

/** reconcile() against the real OS, one run at a time. */
export const runReconcile = serialized(async (): Promise<ReconcileResult> => reconcile(await getDb(), expoNotifier));

/**
 * One handler for every way a notification answer reaches the app: the response
 * listener, the Android background task, and getLastNotificationResponse() on launch.
 * handleAction ignores repeats, so the same response arriving twice is harmless.
 */
export async function onNotificationResponse(response: Notifications.NotificationResponse): Promise<void> {
  const { actionIdentifier, notification } = response;
  const outcome = await handleAction(await getDb(), actionIdentifier, notification.request.content.data as never);
  if (outcome === 'done' || outcome === 'skipped' || outcome === 'snoozed') {
    await Notifications.dismissNotificationAsync(notification.request.identifier).catch(() => undefined);
    await runReconcile();
  }
}

/** A response delivered while JS wasn't listening yet (cold start from a notification). */
export async function processLastResponse(): Promise<void> {
  const last = Notifications.getLastNotificationResponse();
  if (!last) return;
  Notifications.clearLastNotificationResponse();
  await onNotificationResponse(last);
}
