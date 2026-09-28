import { addDays, endDate, todayIn, weekdayIndex } from '../parser/dates';
import { parseOn, WEEKDAYS, type OnRule } from '../parser/rules';
import { inWindow, toMinutes } from '../parser/time';
import type { Notif, Plan, Settings } from '../db/types';
import { wallClock, zonedTime } from './tz';

/** One time a notif should fire, before it is stored as an occurrence. */
export interface Candidate {
  notifId: number;
  planId: number;
  fireAt: number;
  /** Plan-local date. */
  localDate: string;
  /** 0-based: this is the (messageIndex + 1)th time the rule fires since the plan started. */
  messageIndex: number;
  priority: Notif['priority'];
  optional: boolean;
}

export interface ExpandInput {
  plans: Plan[];
  notifs: Notif[];
  settings: Settings;
  now: number;
  /** How many days ahead to expand, counting today. */
  horizonDays: number;
  /** For the global rules on the Quiet tab (quiet hours, daily cap), which follow the phone. */
  deviceTz: string;
}

const RANK = { critical: 2, gentle: 1, silent: 0 } as const;

/** Keeps the most important notifs when a day is over its cap: critical first, required before optional, then earliest. */
function keepTop<T extends Candidate>(items: T[], cap: number): T[] {
  if (items.length <= cap) return items;
  const kept = [...items]
    .sort(
      (a, b) =>
        RANK[b.priority] - RANK[a.priority] || Number(a.optional) - Number(b.optional) || a.fireAt - b.fireAt,
    )
    .slice(0, cap);
  return items.filter((i) => kept.includes(i));
}

function groupBy<T>(items: T[], key: (t: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const i of items) m.set(key(i), [...(m.get(key(i)) ?? []), i]);
  return m;
}

/** How many times `rule` fired on dates in [start, date). */
export function firesBefore(rule: OnRule, start: string, date: string): number {
  if (rule.kind === 'date') return 0;
  const days = Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000);
  if (days <= 0) return 0;
  const weeks = Math.floor(days / 7);
  let n = weeks * rule.days.length;
  const first = weekdayIndex(start);
  for (let i = 0; i < days % 7; i++) if (rule.days.includes(WEEKDAYS[(first + i) % 7]!)) n++;
  return n;
}

/**
 * Expands notif rules into concrete fire times for today and the next days, applying
 * everything that decides whether a notif fires: plan dates and status, pauses,
 * "Quiet till", "Skip today", weekend start, quiet hours (plan and global), and the
 * per-plan and global daily caps. Caps count the whole day, including times already
 * past, so a day can't go over its cap after a reconcile at noon.
 *
 * Returns only future candidates, soonest first. Pure — no database or OS calls.
 */
export function expand({ plans, notifs, settings, now, horizonDays, deviceTz }: ExpandInput): Candidate[] {
  const pauseAll = settings.pause;
  if (pauseAll && pauseAll.until === null) return [];

  const all: Candidate[] = [];
  for (const plan of plans) {
    if (plan.status === 'ended') continue;
    if (plan.status === 'paused' && plan.pausedUntil === null) continue;

    const last = endDate(plan.start, plan.days);
    const today = todayIn(plan.tz, now);
    const perPlan: Candidate[] = [];

    for (let i = 0; i < horizonDays; i++) {
      const date = addDays(today, i);
      if (date < plan.start) continue;
      if (last && date > last) break;
      if (plan.skippedDate === date) continue;
      const weekend = weekdayIndex(date) >= 5;

      for (const n of notifs) {
        if (n.planId !== plan.id || !n.enabled || !n.at) continue;
        const rule = parseOn(n.on);
        if (!rule) continue;
        if (rule.kind === 'date' ? rule.date !== date : !rule.days.includes(WEEKDAYS[weekdayIndex(date)]!)) continue;

        const at = weekend && plan.weekendStart && toMinutes(n.at) < toMinutes(plan.weekendStart) ? plan.weekendStart : n.at;
        const fireAt = zonedTime(date, at, plan.tz);
        const breaksQuiet = n.priority === 'critical' && settings.criticalBreaksQuiet;

        if (plan.status === 'paused' && fireAt < plan.pausedUntil!) continue;
        if (pauseAll && fireAt < pauseAll.until!) continue;
        if (!breaksQuiet) {
          if (plan.quietUntil !== null && fireAt < plan.quietUntil) continue;
          if (inWindow(at, plan.quiet)) continue;
          if (settings.quiet && inWindow(wallClock(fireAt, deviceTz).hm, settings.quiet)) continue;
        }

        const count = rule.kind === 'date' ? 0 : firesBefore(rule, plan.start, date);
        perPlan.push({
          notifId: n.id,
          planId: plan.id,
          fireAt,
          localDate: date,
          messageIndex: count,
          priority: n.priority,
          optional: n.optional,
        });
      }
    }
    for (const day of groupBy(perPlan, (c) => c.localDate).values()) all.push(...keepTop(day, plan.perDay));
  }

  let capped = all;
  if (settings.dailyCap !== null) {
    capped = [];
    const byDeviceDay = groupBy(all, (c) => wallClock(c.fireAt, deviceTz).date);
    for (const day of byDeviceDay.values()) capped.push(...keepTop(day, settings.dailyCap));
  }

  return capped.filter((c) => c.fireAt > now).sort((a, b) => a.fireAt - b.fireAt || a.notifId - b.notifId);
}
