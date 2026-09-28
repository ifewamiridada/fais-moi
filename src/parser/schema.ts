import { z } from 'zod';
import { parseIsoDate } from './dates';

export const FORMAT = 'fais-moi/1';

export const ICONS = ['sun', 'drop', 'bowl', 'move', 'moon', 'book', 'calendar', 'talk', 'spark'] as const;
export type Icon = (typeof ICONS)[number];

const hm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'expected HH:MM (24-hour)');
const isoDate = z.string().refine((s) => parseIsoDate(s) === s, 'expected YYYY-MM-DD');
const day = '(mon|tue|wed|thu|fri|sat|sun)';
const onRule = z
  .string()
  .regex(new RegExp(`^(daily|weekdays|weekends|${day}(,${day})*|\\d{4}-\\d{2}-\\d{2})$`), 'invalid on rule');

/** A notif exactly as the fais-moi v1 format specifies it. */
export const NotifV1 = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  icon: z.enum(ICONS).optional(),
  at: hm,
  on: onRule,
  priority: z.enum(['silent', 'gentle', 'critical']).optional(),
  optional: z.boolean().optional(),
  on_miss: z.enum(['none', 'nudge_once']).optional(),
  messages: z.array(z.string().min(1)).min(1),
});

/**
 * The canonical fais-moi v1 document. Strict about types, loose about extra keys
 * (unknown fields are stripped). The parser itself is far more forgiving — this is
 * what "detected: fais-moi v1" means, and what `serializePlan` produces.
 */
export const PlanV1 = z.object({
  format: z.literal(FORMAT),
  plan: z.string().min(1),
  start: isoDate,
  days: z.number().int().positive().optional(),
  tz: z.string().optional(),
  limits: z
    .object({
      per_day: z.number().int().positive().optional(),
      quiet: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d$/).optional(),
    })
    .optional(),
  notifs: z.array(NotifV1).min(1),
});

export type PlanV1 = z.infer<typeof PlanV1>;
export type NotifV1 = z.infer<typeof NotifV1>;

/** Embedded in prompts as {schema}. Kept short: ChatGPT copies examples more faithfully than prose. */
export const SCHEMA_TEXT = `Schema (fais-moi/1):
{
  "format": "fais-moi/1",
  "plan": "Plan name",
  "start": "YYYY-MM-DD",
  "days": 30,
  "tz": "Area/City",
  "limits": { "per_day": 6, "quiet": "22:30-06:30" },
  "notifs": [
    {
      "id": "short-kebab-id",
      "title": "Short title",
      "icon": "sun",
      "at": "08:00",
      "on": "daily",
      "priority": "gentle",
      "optional": false,
      "messages": ["Message for the 1st time it fires", "…the 2nd time", "…"]
    }
  ]
}
– "on": daily | weekdays | weekends | days like "mon,wed,fri" | one date "YYYY-MM-DD".
– "icon": one of ${ICONS.join(', ')}.
– "priority": silent | gentle | critical.
– Leave out "days" for an ongoing plan.`;
