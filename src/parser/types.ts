import type { Icon } from './schema';

export type Priority = 'silent' | 'gentle' | 'critical';
export type OnMiss = 'none' | 'nudge_once';

/** "HH:MM", 24-hour, wall-clock in the plan tz. */
export type HM = string;

export interface QuietHours {
  start: HM;
  end: HM;
}

/** Plan-level settings as understood from an import. */
export interface PlanDraft {
  title: string;
  /** ISO date, YYYY-MM-DD. */
  start: string;
  /** null = ongoing. */
  days: number | null;
  tz: string;
  perDay: number;
  quiet: QuietHours;
}

/** One scheduled reminder rule. */
export interface NotifDraft {
  id: string;
  title: string;
  icon: Icon;
  /** null only when the import had no readable time — always paired with an error issue. */
  at: HM | null;
  /** Canonical rule: daily | weekdays | weekends | mon,wed,… | YYYY-MM-DD. */
  on: string;
  priority: Priority;
  optional: boolean;
  onMiss: OnMiss;
  enabled: boolean;
  messages: string[];
}

export type IssueCode =
  | 'no-json'
  | 'repaired-json'
  | 'truncated'
  | 'no-notifs'
  | 'prose-skipped'
  | 'plan-title-missing'
  | 'start-missing'
  | 'start-invalid'
  | 'length-guessed'
  | 'days-invalid'
  | 'tz-invalid'
  | 'per-day-invalid'
  | 'quiet-invalid'
  | 'title-missing'
  | 'time-missing'
  | 'time-invalid'
  | 'on-invalid'
  | 'date-outside-plan'
  | 'messages-empty'
  | 'duplicate-id'
  | 'quiet-hours'
  | 'over-cap'
  | 'over-cap-date'
  | 'notif-unreadable';

/**
 * Something the Review / Couldn't-read screens should show.
 * - error:   can't be scheduled as-is (e.g. no time). Blocks "Start plan".
 * - warning: schedulable, but the user should look.
 * - info:    a note about what we did.
 * `fixed` = an automatic fix was applied (the message explains it);
 * otherwise the issue is in a "needs a look" state.
 */
export interface Issue {
  code: IssueCode;
  severity: 'error' | 'warning' | 'info';
  fixed: boolean;
  message: string;
  /** Set when the issue belongs to one notif (id after de-duplication). */
  notifId?: string;
  /** A sentence for the ChatGPT fix-it prompt, when ChatGPT can fix it. */
  fixIt?: string;
}

/** What the input looked like — drives the detected-format chip on Paste. */
export type Source = 'fais-moi' | 'json' | 'text' | 'none';

export interface ParseResult {
  /** ok → Review. partial → Couldn't read (with "Use the N we found"). failed → nothing usable. */
  status: 'ok' | 'partial' | 'failed';
  source: Source;
  plan: PlanDraft;
  notifs: NotifDraft[];
  issues: Issue[];
}

export interface ParseOptions {
  /** ISO date used when the plan has no start. Defaults to the device's today. */
  today?: string;
  /** IANA tz used when the plan has none. Defaults to the device tz. */
  deviceTz?: string;
  /** Used when the plan has no limits (e.g. from the New plan screen). */
  defaults?: { perDay?: number; quiet?: QuietHours };
}
