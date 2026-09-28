/**
 * What the scheduler needs from the OS. The app uses the expo-notifications
 * implementation (src/notify/expo.ts); tests use a fake that records calls.
 */
export interface Notifier {
  /** Whether notifications can be shown right now. */
  canNotify(): Promise<boolean>;
  /** Cancels every scheduled notification this app owns. */
  cancelAll(): Promise<void>;
  /** Schedules one notification and returns the OS identifier. */
  schedule(n: OsNotification): Promise<string>;
}

export type OsKind = 'main' | 'snooze' | 'nudge' | 'keepalive';

export interface OsNotification {
  /** Stable identifier, e.g. "occ-42", "nudge-42", "keepalive". */
  id: string;
  fireAt: number;
  title: string;
  /** Plan name. Omitted for the keep-alive notification. */
  subtitle?: string;
  body: string;
  priority: 'silent' | 'gentle' | 'critical';
  /** Carries the action buttons (Done / In 30 min / Skip today). Omitted for the keep-alive notification. */
  withActions: boolean;
  data: NotificationData;
}

/** Stored in the notification's data so an action can find its occurrence without any other state. */
export interface NotificationData {
  kind: OsKind;
  /** The main occurrence the actions apply to (for nudges and snoozes too). */
  occurrenceId?: number;
  /** The row that fired: the snooze row for a snooze, otherwise the main occurrence. */
  sourceId?: number;
}

export const CATEGORY_ID = 'notif';

export const ACTION = {
  done: 'done',
  snooze: 'snooze',
  skip: 'skip',
} as const;

/** Button titles on the notification (Lock.dc.html). */
export const ACTION_TITLES: Record<keyof typeof ACTION, string> = {
  done: 'Done',
  snooze: 'In 30 min',
  skip: 'Skip today',
};
