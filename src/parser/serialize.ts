import { FORMAT, type PlanV1 } from './schema';
import type { NotifDraft, PlanDraft } from './types';

/**
 * Plan → canonical fais-moi v1 JSON (for "Adjust with ChatGPT" and round-trip tests).
 * Disabled notifs are left out; every remaining notif must have a time.
 */
export function serializePlan(plan: PlanDraft, notifs: NotifDraft[]): PlanV1 {
  return {
    format: FORMAT,
    plan: plan.title,
    start: plan.start,
    ...(plan.days != null ? { days: plan.days } : {}),
    tz: plan.tz,
    limits: { per_day: plan.perDay, quiet: `${plan.quiet.start}-${plan.quiet.end}` },
    notifs: notifs
      .filter((n) => n.enabled)
      .map((n) => {
        if (!n.at) throw new Error(`serializePlan: notif "${n.id}" has no time`);
        return {
          id: n.id,
          title: n.title,
          icon: n.icon,
          at: n.at,
          on: n.on,
          priority: n.priority,
          optional: n.optional,
          ...(n.onMiss !== 'none' ? { on_miss: n.onMiss } : {}),
          messages: n.messages,
        };
      }),
  };
}
