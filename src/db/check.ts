import { isValidTz, parseIsoDate } from '../parser/dates';
import { formatOn, parseOn } from '../parser/rules';
import { ICONS } from '../parser/schema';
import type { HM, QuietHours } from '../parser/types';
import { ValidationError } from './types';

/** Guards for values going into the database. Each throws ValidationError or returns the canonical value. */

const HM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export function hm(v: unknown, field: string): HM {
  if (typeof v !== 'string' || !HM_RE.test(v)) throw new ValidationError(`${field} must be HH:MM (24-hour)`);
  return v;
}

export function isoDate(v: unknown, field: string): string {
  const d = parseIsoDate(v);
  if (!d || d !== v) throw new ValidationError(`${field} must be YYYY-MM-DD`);
  return d;
}

export function quiet(v: QuietHours, field = 'quiet'): QuietHours {
  return { start: hm(v?.start, `${field}.start`), end: hm(v?.end, `${field}.end`) };
}

export function tz(v: unknown): string {
  if (!isValidTz(v)) throw new ValidationError(`Unknown time zone: ${String(v)}`);
  return v;
}

export function positiveInt(v: unknown, field: string, max = 10_000): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > max) {
    throw new ValidationError(`${field} must be a whole number from 1 to ${max}`);
  }
  return v;
}

export function nonEmpty(v: unknown, field: string): string {
  if (typeof v !== 'string' || !v.trim()) throw new ValidationError(`${field} can't be empty`);
  return v.trim();
}

export function onRule(v: unknown): string {
  const rule = parseOn(v);
  if (!rule) throw new ValidationError(`Can't read repeat rule: ${String(v)}`);
  return formatOn(rule);
}

export function icon(v: unknown): string {
  if (!(ICONS as readonly unknown[]).includes(v)) throw new ValidationError(`Unknown icon: ${String(v)}`);
  return v as string;
}

export function messages(v: unknown): string[] {
  if (!Array.isArray(v)) throw new ValidationError('messages must be a list');
  const out = v.filter((m): m is string => typeof m === 'string').map((m) => m.trim()).filter(Boolean);
  if (!out.length) throw new ValidationError('A notif needs at least one message');
  return out;
}

export function oneOf<T extends string>(v: unknown, allowed: readonly T[], field: string): T {
  if (!allowed.includes(v as T)) throw new ValidationError(`${field} must be one of ${allowed.join(', ')}`);
  return v as T;
}
