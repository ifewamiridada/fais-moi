import { parseIsoDate } from './dates';
import { cleanText } from './normalize';
import { formatOn, parseOn } from './rules';
import { parseTime } from './time';

/** Shape handed to normalize(): the same keys a fais-moi JSON document uses. */
export interface TextPlan {
  plan?: string;
  start?: string;
  days?: number;
  limits?: { quiet?: string };
  notifs: Array<{ title: string; at?: string; on?: string; messages: string[] }>;
  /** Non-empty lines that weren't a reminder, heading or plan detail. */
  skipped: number;
}

const TIME = String.raw`(?:\d{1,2}(?:[:.h]\d{2})?\s*(?:[ap]\.?\s?m\.?)|\d{1,2}[:.h]\d{2}|noon|midday)`;
const SEP = String.raw`\s*(?:[—–|·:]|-(?=\s)|\s)\s*`;

/** "Day 3 — 8:00 AM — Breakfast: …", "08:00 Breakfast - …", "8am | Breakfast | …" */
const TIME_FIRST = new RegExp(String.raw`^(?:day\s*\d+\s*[—–:|·-]?\s*)?(${TIME})(?:\s*[-–—]\s*${TIME})?${SEP}(.+)$`, 'i');
/** "Breakfast (8:00 AM): …", "Breakfast @ 08:00 — …", "Breakfast at 8am: …" */
const TITLE_FIRST = new RegExp(
  String.raw`^([^:—–|]{2,50}?)\s*(?:\(\s*(${TIME})\s*\)|(?:@|\bat\b|[—–|]|-(?=\s))\s*(${TIME}))\s*(?:[:—–|]|-(?=\s))?\s*(.*)$`,
  'i',
);

const DAY = String.raw`(?:mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:r(?:s(?:day)?)?)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)s?`;
const DAY_WORD = new RegExp(String.raw`\b(daily|every ?day|weekdays?|weekends?|${DAY}(?:\s*(?:[-–—]|to)\s*${DAY})?)\b`, 'i');

/** Pulls a repeat rule out of a title like "Meal prep (Saturdays)" or "Weekly review — every Sunday". */
function takeDays(title: string): { title: string; on?: string } {
  const paren = /\s*\(([^)]*)\)\s*$/.exec(title);
  if (paren) {
    const rule = parseOn(paren[1]!.replace(/\bonly\b/i, ''));
    if (rule) return { title: title.slice(0, paren.index).trim(), on: formatOn(rule) };
  }
  const tail = /\s*(?:[—–,]|-\s)\s*((?:every|on|only)?\s*[a-z ,&-]+?)\s*(?:only)?$/i.exec(title);
  if (tail) {
    const rule = parseOn(tail[1]!);
    if (rule) return { title: title.slice(0, tail.index).trim(), on: formatOn(rule) };
  }
  return { title };
}

/** "Breakfast: Start with…" / "Mental reset - What can you release?" → [title, message]. */
function splitTitle(rest: string): [string, string] {
  const m = /^(.{1,60}?)\s*(?::\s|\s[—–-]\s|[—–]\s?)\s*(.+)$/.exec(rest);
  if (m) return [m[1]!, m[2]!];
  return [rest, rest];
}

function stripMarkdown(line: string): { text: string; heading: boolean; bullet: boolean } {
  let s = line.trim();
  let heading = /^#{1,6}\s/.test(s);
  s = s.replace(/^#{1,6}\s+/, '');
  const bullet = /^(?:[-*•+▪◦]|\d{1,2}[.)])\s+/.test(s);
  s = s.replace(/^(?:[-*•+▪◦]|\d{1,2}[.)])\s+/, '');
  s = s.replace(/^\[[ x]\]\s+/i, '');
  if (/^(\*\*|__)[^*_]+(\*\*|__):?$/.test(s)) heading = true;
  s = s.replace(/\*\*|__|`/g, '').replace(/(^|\s)\*([^*]+)\*(?=\s|$|[:.,])/g, '$1$2').trim();
  return { text: s, heading, bullet };
}

const END_HEADING = /^(?:a few |some |quick )?(tips?|notes?|summary|why this works|how to use|final thoughts|remember|next steps)\b/i;
const GENERIC_HEADING = /^(here(?:'|’)?s|sure|below|notes?|tips?|summary|how to|schedule|reminders?|daily reminders|your plan)\b/i;

/**
 * Fallback for replies with no usable JSON. Reads one reminder per line; anything it
 * can't place is either skipped (prose) or kept without a time so Review can flag it.
 */
export function parseText(input: string): TextPlan {
  const out: TextPlan = { notifs: [], skipped: 0 };
  const byKey = new Map<string, TextPlan['notifs'][number]>();
  let sectionOn: string | undefined;
  let inList = false;
  let pendingTimeless: Array<{ title: string; message: string; on?: string }> = [];

  const add = (title: string, at: string | undefined, message: string, on: string | undefined) => {
    const t = cleanText(title);
    const msg = cleanText(message);
    if (!t) return;
    const key = `${t.toLowerCase()}|${at ?? ''}|${on ?? ''}`;
    const existing = byKey.get(key);
    if (existing) {
      if (msg && !existing.messages.includes(msg)) existing.messages.push(msg);
      return;
    }
    const n = { title: t, ...(at ? { at } : {}), ...(on ? { on } : {}), messages: msg ? [msg] : [] };
    byKey.set(key, n);
    out.notifs.push(n);
  };

  const flushTimeless = (keep: boolean) => {
    if (keep) for (const p of pendingTimeless) add(p.title, undefined, p.message, p.on);
    else out.skipped += pendingTimeless.length;
    pendingTimeless = [];
  };

  for (const rawLine of input.split('\n')) {
    if (!rawLine.trim()) continue;
    if (/^\s*```/.test(rawLine)) continue;

    // Markdown tables: | 08:00 | Breakfast | Start with… |
    if (/^\s*\|.*\|\s*$/.test(rawLine)) {
      const cells = rawLine.trim().slice(1, -1).split('|').map((c) => stripMarkdown(c).text);
      if (cells.every((c) => /^:?-{2,}:?$/.test(c) || !c)) continue;
      const ti = cells.findIndex((c) => parseTime(c));
      if (ti < 0) {
        out.skipped++;
        continue;
      }
      const others = cells.filter((_, i) => i !== ti && cells[i]);
      const dayCell = others.find((c) => parseOn(c));
      const [title = '', message = title] = others.filter((c) => c !== dayCell);
      const t = takeDays(title);
      add(t.title, parseTime(cells[ti]!)!, message, dayCell ? formatOn(parseOn(dayCell)!) : (t.on ?? sectionOn));
      inList = true;
      continue;
    }

    const { text, heading, bullet } = stripMarkdown(rawLine);
    if (!text) continue;

    // Plan details.
    const startM = /\bstart(?:s|ing)?(?:\s+date)?\s*(?:on|:|-|—)?\s*(\d{4}-\d{1,2}-\d{1,2})/i.exec(text);
    if (startM && !out.start) out.start = parseIsoDate(startM[1]) ?? undefined;
    const lenM = /\b(?:length|duration)\s*[:—-]\s*(\d{1,4})\s*days?\b/i.exec(text) ?? /\b(\d{1,3})[- ]day\b/i.exec(text);
    const quietM = /\bquiet(?:\s+hours)?\s*[:—-]\s*(.+)$/i.exec(text);
    if (quietM) {
      out.limits = { quiet: quietM[1]!.trim() };
      continue;
    }

    const timed = TIME_FIRST.exec(text) ?? null;
    let titled = timed ? null : TITLE_FIRST.exec(text);
    // Title-first lines are only trusted inside a list; prose like "sleep at 10pm…" is not a reminder.
    if (titled && !((bullet || inList) && titled[1]!.trim().split(/\s+/).length <= 6)) titled = null;
    if (timed || titled) {
      flushTimeless(true);
      const at = parseTime(timed ? timed[1] : (titled![2] ?? titled![3]));
      if (at) {
        let title: string;
        let message: string;
        if (timed) [title, message] = splitTitle(timed[2]!.trim());
        else [title, message] = [titled![1]!, titled![4]?.trim() || titled![1]!];
        const t = takeDays(title.trim());
        add(t.title, at, message, t.on ?? sectionOn);
        inList = true;
        continue;
      }
    }

    if (startM || (lenM && !out.notifs.length && (heading || /^(length|duration)\b/i.test(text)))) {
      if (lenM && !out.days) out.days = Number(lenM[1]);
      if (heading && !out.plan && !GENERIC_HEADING.test(text)) out.plan = text.replace(/:$/, '');
      continue;
    }

    if (heading || (/:$/.test(text) && text.length < 60)) {
      const label = text.replace(/:$/, '');
      if (END_HEADING.test(label) && out.notifs.length) {
        // "Tips:" / "Notes:" after the list — what follows isn't reminders.
        flushTimeless(true);
        inList = false;
        continue;
      }
      const dayM = DAY_WORD.exec(label);
      const rule = dayM ? parseOn(dayM[1]!) : null;
      if (rule) sectionOn = formatOn(rule);
      else if (/^day\s*\d+\b/i.test(label)) {
        /* Day-by-day listing: keep merging the same reminders into one notif. */
      } else if (!out.plan && !out.notifs.length && heading && !GENERIC_HEADING.test(label)) {
        out.plan = label;
        if (lenM && !out.days) out.days = Number(lenM[1]);
      }
      continue;
    }

    // "- Evening wind-down: Put the phone away" — looks like a reminder, but no time.
    const timeless = bullet ? /^([^:]{2,40}):\s+(.+)$/.exec(text) : null;
    if (timeless && inList && timeless[1]!.trim().split(/\s+/).length <= 5) {
      const t = takeDays(timeless[1]!.trim());
      pendingTimeless.push({ title: t.title, message: timeless[2]!, on: t.on ?? sectionOn });
      continue;
    }

    // Prose: intro, outro, tips. A prose paragraph also ends the reminder list.
    flushTimeless(true);
    out.skipped++;
    inList = false;
  }
  flushTimeless(inList);
  return out;
}

