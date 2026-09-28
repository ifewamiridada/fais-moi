import { endDate, isValidTz, parseIsoDate } from './dates';
import { formatOn, parseOn } from './rules';
import { ICONS, type Icon } from './schema';
import { parseQuiet, parseTime } from './time';
import type { Issue, NotifDraft, OnMiss, PlanDraft, Priority, QuietHours } from './types';

export interface NormalizeContext {
  today: string;
  deviceTz: string;
  perDay: number;
  quiet: QuietHours;
  /** Text imports guess a length (30 days) and say so; JSON without `days` means ongoing. */
  fromText: boolean;
}

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);
const keyOf = (k: string) => k.toLowerCase().replace(/[\s_-]/g, '');

/** Case/underscore-insensitive lookup across aliases: pick(o, 'at', 'time'). */
function pick(o: Obj, ...aliases: string[]): unknown {
  const want = aliases.map(keyOf);
  for (const k of want) {
    for (const [key, value] of Object.entries(o)) {
      if (keyOf(key) === k && value !== undefined && value !== null && value !== '') return value;
    }
  }
  return undefined;
}

const NOTIF_KEYS = ['notifs', 'notif', 'reminders', 'notifications', 'cues', 'items', 'schedule', 'routine'];

/** Like pick, but only returns non-empty strings. */
function pickStr(o: Obj, ...aliases: string[]): string {
  for (const a of aliases) {
    const v = pick(o, a);
    if (typeof v === 'string' && v.trim()) return v;
  }
  return '';
}

/** Finds the notif list: top level, or nested under `plan: { … }`. */
function findNotifs(raw: unknown): { root: Obj; list: unknown[] | null } {
  if (Array.isArray(raw)) return { root: {}, list: raw };
  if (!isObj(raw)) return { root: {}, list: null };
  const nested = pick(raw, 'plan');
  const root: Obj = isObj(nested) ? { ...raw, ...nested } : raw;
  const list = pick(root, ...NOTIF_KEYS);
  return { root, list: Array.isArray(list) ? list : null };
}

export function slug(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

const humanize = (id: string) => {
  const s = id.replace(/[-_]+/g, ' ').trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
};

/** Strips markdown emphasis, wrapping quotes and extra whitespace from a message or title. */
export function cleanText(s: string): string {
  return s
    .replace(/\*\*|__|`/g, '')
    .replace(/^\s*[*_]|[*_]\s*$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^["“'‘](.*)["”'’]$/, '$1')
    .trim();
}

const ICON_ALIASES: Record<string, Icon> = {
  morning: 'sun', sunrise: 'sun', wake: 'sun',
  water: 'drop', hydration: 'drop', hydrate: 'drop',
  food: 'bowl', meal: 'bowl', eat: 'bowl', breakfast: 'bowl', lunch: 'bowl', dinner: 'bowl',
  exercise: 'move', walk: 'move', run: 'move', workout: 'move', stretch: 'move', fitness: 'move',
  sleep: 'moon', night: 'moon', bed: 'moon', evening: 'moon',
  read: 'book', study: 'book', journal: 'book', bible: 'book',
  date: 'calendar', plan: 'calendar', schedule: 'calendar',
  call: 'talk', chat: 'talk', message: 'talk', social: 'talk',
};

function toIcon(v: unknown, title: string): Icon {
  if (v === undefined) {
    // No icon given: take a hint from the title ("Water" → drop), else spark.
    for (const word of title.toLowerCase().split(/[^a-z]+/)) if (ICON_ALIASES[word]) return ICON_ALIASES[word];
    return 'spark';
  }
  if (typeof v !== 'string') return 'spark';
  const s = v.trim().toLowerCase();
  if ((ICONS as readonly string[]).includes(s)) return s as Icon;
  return ICON_ALIASES[s] ?? 'spark';
}

function toPriority(v: unknown): Priority {
  const s = typeof v === 'string' ? v.toLowerCase().replace(/[’']/g, '') : '';
  if (/^(silent|quiet|low|none|mute[d]?)$/.test(s)) return 'silent';
  if (/^(critical|high|urgent|important|cant ?miss|must|time[- ]sensitive)$/.test(s)) return 'critical';
  return 'gentle';
}

function toBool(v: unknown): boolean {
  if (typeof v === 'boolean') return v;
  return typeof v === 'string' && /^(true|yes|y|1)$/i.test(v.trim());
}

function toOnMiss(v: unknown): OnMiss {
  return typeof v === 'string' && /nudge/i.test(v) ? 'nudge_once' : 'none';
}

function toInt(v: unknown): number | null {
  if (typeof v === 'number') return Number.isInteger(v) ? v : null;
  if (typeof v === 'string') {
    const m = /^\s*(\d+)\s*(days?)?\s*$/i.exec(v);
    return m ? Number(m[1]) : null;
  }
  return null;
}

function toMessages(v: unknown): string[] {
  const list = Array.isArray(v) ? v : v === undefined ? [] : [v];
  const out: string[] = [];
  for (const item of list) {
    let s: unknown = item;
    if (isObj(item)) s = pick(item, 'text', 'message', 'body', 'msg', 'content');
    if (typeof s === 'number') s = String(s);
    if (typeof s !== 'string') continue;
    const c = cleanText(s);
    if (c) out.push(c);
  }
  return out;
}

function normalizePlan(root: Obj, ctx: NormalizeContext, issues: Issue[]): PlanDraft {
  let title = cleanText(pickStr(root, 'plan', 'title', 'name', 'planname', 'plantitle', 'goal'));
  if (!title) {
    title = 'My plan';
    issues.push({
      code: 'plan-title-missing',
      severity: 'info',
      fixed: true,
      message: 'The plan had no name, so we called it “My plan”. You can rename it.',
    });
  }

  const rawStart = pick(root, 'start', 'startdate', 'begin', 'starts');
  let start = parseIsoDate(rawStart);
  const rawDays = pick(root, 'days', 'length', 'duration', 'lengthdays');
  let days = rawDays === undefined ? null : toInt(rawDays);

  if (rawDays !== undefined && (days === null || days < 1 || days > 3660)) {
    issues.push({
      code: 'days-invalid',
      severity: 'warning',
      fixed: true,
      message: `We couldn't read the plan length (“${String(rawDays)}”), so it runs until you stop it.`,
      fixIt: 'Give "days" as a whole number.',
    });
    days = null;
  }

  if (!start && rawStart !== undefined) {
    issues.push({
      code: 'start-invalid',
      severity: 'warning',
      fixed: true,
      message: `We couldn't read the start date (“${String(rawStart)}”), so it starts today.`,
      fixIt: `Start ${ctx.today}.`,
    });
    start = ctx.today;
  } else if (!start && ctx.fromText && rawDays === undefined) {
    issues.push({
      code: 'length-guessed',
      severity: 'warning',
      fixed: true,
      message: "No start date or length — we'd guess today, 30 days.",
      fixIt: `Start ${ctx.today}, 30 days.`,
    });
    start = ctx.today;
    days = 30;
  } else if (!start) {
    issues.push({ code: 'start-missing', severity: 'info', fixed: true, message: 'No start date, so it starts today.' });
    start = ctx.today;
  } else if (ctx.fromText && rawDays === undefined) {
    issues.push({
      code: 'length-guessed',
      severity: 'warning',
      fixed: true,
      message: "No length — we'd guess 30 days.",
      fixIt: `Make it ${30} days.`,
    });
    days = 30;
  }

  const rawTz = pick(root, 'tz', 'timezone', 'timeZone');
  let tz = ctx.deviceTz;
  if (rawTz !== undefined) {
    if (isValidTz(rawTz)) tz = rawTz;
    else
      issues.push({
        code: 'tz-invalid',
        severity: 'info',
        fixed: true,
        message: `Unknown time zone “${String(rawTz)}” — using this phone's (${ctx.deviceTz}).`,
      });
  }

  const limits = pick(root, 'limits', 'limit', 'settings');
  const lim: Obj = isObj(limits) ? { ...root, ...limits } : root;

  let perDay = ctx.perDay;
  const rawPerDay = pick(lim, 'perday', 'maxperday', 'dailylimit', 'max', 'maxreminders');
  if (rawPerDay !== undefined) {
    const n = toInt(rawPerDay);
    if (n && n > 0 && n <= 50) perDay = n;
    else
      issues.push({
        code: 'per-day-invalid',
        severity: 'info',
        fixed: true,
        message: `We couldn't read the daily limit (“${String(rawPerDay)}”) — using ${ctx.perDay}.`,
      });
  }

  let quiet = ctx.quiet;
  const rawQuiet = pick(lim, 'quiet', 'quiethours', 'donotdisturb', 'dnd');
  if (rawQuiet !== undefined) {
    const q = parseQuiet(rawQuiet);
    if (q) quiet = q;
    else
      issues.push({
        code: 'quiet-invalid',
        severity: 'info',
        fixed: true,
        message: `We couldn't read the quiet hours (“${String(rawQuiet)}”) — using ${ctx.quiet.start}–${ctx.quiet.end}.`,
      });
  }

  return { title, start, days, tz, perDay, quiet };
}

function normalizeNotif(
  raw: unknown,
  index: number,
  plan: PlanDraft,
  issues: Issue[],
  claimId: (id: string) => string,
): NotifDraft | null {
  if (!isObj(raw)) {
    issues.push({
      code: 'notif-unreadable',
      severity: 'warning',
      fixed: true,
      message: `Notif #${index + 1} wasn't something we could read, so we left it out.`,
    });
    return null;
  }

  const rawId = pick(raw, 'id', 'key', 'slug');
  let title = cleanText(pickStr(raw, 'title', 'name', 'label', 'reminder', 'task'));
  let id = typeof rawId === 'string' || typeof rawId === 'number' ? slug(String(rawId)) : '';
  if (!title && id) title = humanize(id);
  if (!id) id = slug(title) || `notif-${index + 1}`;
  id = claimId(id);
  if (!title) {
    title = `Notif ${index + 1}`;
    issues.push({
      code: 'title-missing',
      severity: 'info',
      fixed: true,
      notifId: id,
      message: `Notif #${index + 1} had no title, so we called it “${title}”.`,
    });
  }

  const messages = toMessages(pick(raw, 'messages', 'message', 'texts', 'text', 'variants', 'body', 'copy'));
  if (!messages.length) {
    issues.push({
      code: 'messages-empty',
      severity: 'error',
      fixed: false,
      notifId: id,
      message: `“${title}” has no messages.`,
      fixIt: `Write messages for “${title}”.`,
    });
  }

  const rawAt = pick(raw, 'at', 'time', 'hour', 'fireat');
  const at = parseTime(typeof rawAt === 'number' ? `${rawAt}:00` : rawAt);
  if (rawAt === undefined) {
    issues.push({
      code: 'time-missing',
      severity: 'error',
      fixed: false,
      notifId: id,
      message: `“${title}” has no time.`,
      fixIt: `Give “${title}” a time.`,
    });
  } else if (!at) {
    issues.push({
      code: 'time-invalid',
      severity: 'error',
      fixed: false,
      notifId: id,
      message: `“${title}” has a time we couldn't read (“${String(rawAt)}”).`,
      fixIt: `Give “${title}” a 24-hour time like 08:00.`,
    });
  }

  const rawOn = pick(raw, 'on', 'repeat', 'days', 'frequency', 'recurrence', 'schedule', 'date');
  let on = 'daily';
  if (rawOn !== undefined) {
    const rule = parseOn(rawOn);
    if (rule) {
      on = formatOn(rule);
      const last = endDate(plan.start, plan.days);
      if (rule.kind === 'date' && (rule.date < plan.start || (last && rule.date > last))) {
        issues.push({
          code: 'date-outside-plan',
          severity: 'warning',
          fixed: false,
          notifId: id,
          message: `“${title}” is set for ${rule.date}, outside this plan's dates.`,
          fixIt: `Move “${title}” to a date inside the plan.`,
        });
      }
    } else {
      issues.push({
        code: 'on-invalid',
        severity: 'warning',
        fixed: false,
        notifId: id,
        message: `We couldn't tell which days “${title}” repeats (“${String(rawOn)}”), so it's set to daily for now.`,
        fixIt: `Give “${title}” repeat days: daily, weekdays, weekends or days like mon,wed,fri.`,
      });
    }
  }

  const enabledRaw = pick(raw, 'enabled', 'active');
  return {
    id,
    title,
    icon: toIcon(pick(raw, 'icon', 'emoji', 'category'), title),
    at,
    on,
    priority: toPriority(pick(raw, 'priority', 'level', 'importance')),
    optional: toBool(pick(raw, 'optional')),
    onMiss: toOnMiss(pick(raw, 'onmiss', 'ifmissed', 'missed')),
    enabled: enabledRaw === undefined ? true : toBool(enabledRaw),
    messages,
  };
}

/** Raw (already JSON-parsed or text-derived) object → drafts + issues. Plan-level checks live in validate.ts. */
export function normalize(raw: unknown, ctx: NormalizeContext) {
  const issues: Issue[] = [];
  const { root, list } = findNotifs(raw);
  const plan = normalizePlan(root, ctx, issues);
  const notifs: NotifDraft[] = [];
  const seen = new Set<string>();
  const claimId = (id: string) => {
    if (!seen.has(id)) {
      seen.add(id);
      return id;
    }
    let i = 2;
    while (seen.has(`${id}-${i}`)) i++;
    const renamed = `${id}-${i}`;
    seen.add(renamed);
    issues.push({
      code: 'duplicate-id',
      severity: 'info',
      fixed: true,
      notifId: renamed,
      message: `Two notifs shared the id “${id}” — we renamed one to “${renamed}”.`,
    });
    return renamed;
  };
  (list ?? []).forEach((item, i) => {
    const n = normalizeNotif(item, i, plan, issues, claimId);
    if (n) notifs.push(n);
  });
  return { plan, notifs, issues, foundList: list !== null };
}

