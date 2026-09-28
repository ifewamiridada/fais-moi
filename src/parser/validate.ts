import { formatDate, weekdayIndex } from './dates';
import { describeOn, formatOn, listDays, parseOn, WEEKDAYS, type Weekday } from './rules';
import { formatQuiet, formatTime, inWindow } from './time';
import type { Issue, NotifDraft, PlanDraft, Priority } from './types';

export function checkQuietHours(plan: PlanDraft, notifs: NotifDraft[], issues: Issue[]): void {
  for (const n of notifs) {
    if (!n.enabled || !n.at || !inWindow(n.at, plan.quiet)) continue;
    issues.push({
      code: 'quiet-hours',
      severity: 'warning',
      fixed: false,
      notifId: n.id,
      message: `${n.title} at ${formatTime(n.at)} falls in quiet hours (${formatQuiet(plan.quiet)}).`,
      fixIt: `Move “${n.title}” outside ${plan.quiet.start}–${plan.quiet.end}.`,
    });
  }
}

const RANK: Record<Priority, number> = { silent: 0, gentle: 1, critical: 2 };

/**
 * Which notif gives way when a day is over the limit: optional before required,
 * then lowest priority, then the one that fires on the most days (losing one day
 * hurts it least), then the one listed last.
 */
function pickVictim(firing: Array<{ n: NotifDraft; days: Weekday[]; index: number }>) {
  return [...firing].sort(
    (a, b) =>
      Number(b.n.optional) - Number(a.n.optional) ||
      RANK[a.n.priority] - RANK[b.n.priority] ||
      b.days.length - a.days.length ||
      b.index - a.index,
  )[0]!;
}

/**
 * Enforces `perDay` on every weekday by taking the lowest-priority notif off
 * over-full days, and explains each move. One-off dates that tip a day over are
 * flagged rather than moved, since a weekly rule can't skip a single date.
 */
export function enforceDailyCap(plan: PlanDraft, notifs: NotifDraft[], issues: Issue[]): void {
  const weekly = notifs
    .map((n, index) => ({ n, index, rule: parseOn(n.on) }))
    .filter((x) => x.n.enabled && x.rule?.kind === 'weekly')
    .map((x) => ({ n: x.n, index: x.index, days: [...(x.rule as { days: Weekday[] }).days] }));

  const moves = new Map<NotifDraft, { from: Weekday[]; worst: number; index: number }>();
  for (const day of WEEKDAYS) {
    let firing = weekly.filter((w) => w.days.includes(day));
    const before = firing.length;
    while (firing.length > plan.perDay) {
      const victim = pickVictim(firing);
      victim.days = victim.days.filter((d) => d !== day);
      const m = moves.get(victim.n) ?? { from: [], worst: 0, index: victim.index };
      m.from.push(day);
      m.worst = Math.max(m.worst, before);
      moves.set(victim.n, m);
      firing = firing.filter((w) => w !== victim);
    }
  }

  for (const [n, m] of [...moves].sort((a, b) => a[1].index - b[1].index)) {
    const days = weekly.find((w) => w.n === n)!.days;
    const over = `${listDays(m.from)} had ${m.worst} notifs — over your limit of ${plan.perDay}.`;
    let did: string;
    if (!days.length) {
      n.enabled = false;
      did = `We turned off ${n.title}.`;
    } else {
      n.on = formatOn({ kind: 'weekly', days });
      const label = describeOn(n.on);
      did =
        n.on === 'weekdays' || n.on === 'weekends'
          ? `We moved ${n.title} to ${label.toLowerCase()} only.`
          : `We took ${n.title} off ${listDays(m.from)}.`;
    }
    issues.push({ code: 'over-cap', severity: 'warning', fixed: true, notifId: n.id, message: `${over} ${did}` });
  }

  // One-off dates, checked against what's left after the weekly fixes.
  const oneOffs = notifs.filter((n) => n.enabled && parseOn(n.on)?.kind === 'date');
  const flagged = new Set<string>();
  for (const o of oneOffs) {
    const date = o.on;
    if (flagged.has(date)) continue;
    const wd = WEEKDAYS[weekdayIndex(date)]!;
    const count =
      notifs.filter((n) => n.enabled && parseOn(n.on)?.kind === 'weekly' && (parseOn(n.on) as { days: Weekday[] }).days.includes(wd)).length +
      oneOffs.filter((n) => n.on === date).length;
    if (count <= plan.perDay) continue;
    flagged.add(date);
    issues.push({
      code: 'over-cap-date',
      severity: 'warning',
      fixed: false,
      notifId: o.id,
      message: `${formatDate(date)} has ${count} notifs — over your limit of ${plan.perDay}.`,
      fixIt: `Keep ${date} to ${plan.perDay} reminders or fewer.`,
    });
  }
}

