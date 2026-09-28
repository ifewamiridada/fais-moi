import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { ACTION, ACTION_TITLES, CATEGORY_ID, type Notifier, type OsNotification } from '../scheduler/notifier';

/**
 * Android sound and importance live on channels, one per priority.
 * silent = no sound; gentle = default; critical = high importance.
 */
const CHANNELS: Record<OsNotification['priority'], Notifications.NotificationChannelInput> = {
  silent: { name: 'Silent notifs', importance: Notifications.AndroidImportance.LOW, sound: null, enableVibrate: false },
  gentle: { name: 'Notifs', importance: Notifications.AndroidImportance.DEFAULT },
  critical: { name: "Can't-miss notifs", importance: Notifications.AndroidImportance.HIGH },
};

/**
 * Registers the Done / In 30 min / Skip today category, the Android channels, and
 * how notifications show while the app is open. Safe to call on every launch.
 *
 * The buttons don't open the app. iOS then delivers the answer only while the app is
 * running or suspended in the background — if the system has terminated the app, the
 * tap is lost and the occurrence ends up missed. See the step 3 notes in README.
 */
export async function setupNotifications(): Promise<void> {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
    }),
  });
  await Notifications.setNotificationCategoryAsync(
    CATEGORY_ID,
    (Object.keys(ACTION) as Array<keyof typeof ACTION>).map((key) => ({
      identifier: ACTION[key],
      buttonTitle: ACTION_TITLES[key],
      options: { opensAppToForeground: false },
    })),
  );
  if (Platform.OS === 'android') {
    for (const [id, channel] of Object.entries(CHANNELS)) await Notifications.setNotificationChannelAsync(id, channel);
  }
}

export async function permissionStatus(): Promise<'granted' | 'denied' | 'undetermined'> {
  const p = await Notifications.getPermissionsAsync();
  if (p.granted || p.ios?.status === Notifications.IosAuthorizationStatus.PROVISIONAL) return 'granted';
  return p.canAskAgain ? 'undetermined' : 'denied';
}

/** The OS prompt. Welcome explains why first (step 4). */
export async function requestPermission(): Promise<boolean> {
  const p = await Notifications.requestPermissionsAsync({
    ios: { allowAlert: true, allowSound: true, allowBadge: false },
  });
  return p.granted;
}

export const expoNotifier: Notifier = {
  async canNotify() {
    return (await permissionStatus()) === 'granted';
  },
  async cancelAll() {
    await Notifications.cancelAllScheduledNotificationsAsync();
  },
  async schedule(n) {
    return Notifications.scheduleNotificationAsync({
      identifier: n.id,
      content: {
        title: n.title,
        subtitle: n.subtitle ?? null,
        body: n.body,
        data: { ...n.data },
        categoryIdentifier: n.withActions ? CATEGORY_ID : undefined,
        sound: n.priority === 'silent' ? false : 'default',
        interruptionLevel: n.priority === 'critical' ? 'timeSensitive' : 'active',
      },
      // Android: a plain date trigger, inexact unless the app holds the exact-alarm
      // permission — which fais-moi deliberately never asks for.
      trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: n.fireAt, channelId: n.priority },
    });
  },
};
