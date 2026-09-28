import type { HM, NotifDraft, PlanDraft, QuietHours } from '../parser/types';

export type Bind = string | number | null;

/**
 * The slice of expo-sqlite's `SQLiteDatabase` the repositories use. In the app this is
 * `await SQLite.openDatabaseAsync('fais-moi.db')`; in tests it's `node:sqlite` (see __tests__/nodeDb.ts).
 */
export interface Db {
  execAsync(sql: string): Promise<void>;
  runAsync(sql: string, params?: Bind[]): Promise<{ lastInsertRowId: number; changes: number }>;
  getFirstAsync<T>(sql: string, params?: Bind[]): Promise<T | null>;
  getAllAsync<T>(sql: string, params?: Bind[]): Promise<T[]>;
  withTransactionAsync(task: () => Promise<void>): Promise<void>;
}

export type PlanStatus = 'active' | 'paused' | 'ended';

/** Instants (pausedUntil, createdAt, …) are epoch ms. Dates and times are wall-clock in `tz`. */
export interface Plan extends PlanDraft {
  id: number;
  status: PlanStatus;
  /** Paused plans: when to resume. null = until the user resumes. */
  pausedUntil: number | null;
  /** "Quiet till…": the plan stays active but nothing fires before this instant. */
  quietUntil: number | null;
  /** "Skip today": the plan-local date that is skipped. */
  skippedDate: string | null;
  /** "Weekends start at 9:00": weekend notifs earlier than this wait until then. */
  weekendStart: HM | null;
  createdAt: number;
}

/** A stored notif. `key` is the import id ("breakfast"), unique within its plan. */
export interface Notif extends Omit<NotifDraft, 'id'> {
  id: number;
  planId: number;
  key: string;
  sort: number;
}

export type OccurrenceState = 'pending' | 'done' | 'snoozed' | 'skipped' | 'missed';

export interface Occurrence {
  id: number;
  notifId: number;
  fireAt: number;
  /** Plan-local date the occurrence belongs to (YYYY-MM-DD). */
  localDate: string;
  messageIndex: number;
  osNotificationId: string | null;
  state: OccurrenceState;
  actedAt: number | null;
}

/** Global rules from the Quiet tab, plus first-run state. */
export interface Settings {
  /** Welcome has been shown. */
  onboarded: boolean;
  /** Used in the Today greeting. */
  name: string | null;
  /** Pause everything. `until: null` = "Till I'm back". */
  pause: { until: number | null } | null;
  /** Quiet hours above every plan. */
  quiet: QuietHours | null;
  /** Most a day across all plans. */
  dailyCap: number | null;
  /** "Can't miss" (critical) notifs ignore quiet hours. */
  criticalBreaksQuiet: boolean;
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}
