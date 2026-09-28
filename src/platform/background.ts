/**
 * Everything that must exist before any screen renders, including when the OS
 * starts the JS bundle in the background. Imported first from index.ts.
 */
import * as BackgroundTask from 'expo-background-task';
import * as Notifications from 'expo-notifications';
import * as TaskManager from 'expo-task-manager';
import { setupNotifications } from '../notify/expo';
import { onNotificationResponse, runReconcile } from './runtime';

export const RECONCILE_TASK = 'fais-moi.reconcile';
export const NOTIFICATION_TASK = 'fais-moi.notification-response';

// Best effort: the OS decides when (iOS often overnight). Keeps the 60-slot window topped up.
TaskManager.defineTask(RECONCILE_TASK, async () => {
  try {
    await runReconcile();
    return BackgroundTask.BackgroundTaskResult.Success;
  } catch {
    return BackgroundTask.BackgroundTaskResult.Failed;
  }
});

// Android: action taps while the app is backgrounded or terminated arrive here.
TaskManager.defineTask<Notifications.NotificationTaskPayload>(NOTIFICATION_TASK, async ({ data }) => {
  if (data && 'actionIdentifier' in data) await onNotificationResponse(data);
});

// iOS (and Android in the foreground): action taps while JS is running.
Notifications.addNotificationResponseReceivedListener((response) => {
  void onNotificationResponse(response);
});

export async function registerBackgroundWork(): Promise<void> {
  await setupNotifications();
  await Notifications.registerTaskAsync(NOTIFICATION_TASK).catch(() => undefined);
  await BackgroundTask.registerTaskAsync(RECONCILE_TASK, { minimumInterval: 6 * 60 }).catch(() => undefined);
}
