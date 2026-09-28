import JSON5 from 'json5';

export interface Extracted {
  value: unknown;
  /** Needed more than JSON.parse (smart quotes, trailing commas, comments…). */
  repaired: boolean;
  /** The JSON ended early and was closed off; the last item may be missing. */
  truncated: boolean;
  /** Offsets of the JSON inside the cleaned input, for skipping it in the text fallback. */
  span: [number, number];
}

/** Invisible characters and non-breaking spaces that break JSON.parse. */
export function cleanInput(input: string): string {
  return input
    .replace(/^﻿/, '')
    .replace(/[​-‍⁠﻿]/g, '')
    .replace(/[   ]/g, ' ')
    .replace(/\r\n?/g, '\n');
}

/**
 * Finds JSON candidates in order: fenced code blocks first, then the outermost
 * {…} / […] span of the whole text (covers "json Copy code {…}" pastes from the web UI).
 */
function candidates(text: string): Array<{ body: string; start: number }> {
  const out: Array<{ body: string; start: number }> = [];
  const fence = /```[ \t]*([\w-]*)[^\n]*\n([\s\S]*?)(?:```|$)/g;
  for (let m; (m = fence.exec(text)); ) {
    const body = m[2] ?? '';
    const lang = (m[1] ?? '').toLowerCase();
    if (!/[{[]/.test(body)) continue;
    if (lang && !/^(json5?|jsonc|javascript|js)$/.test(lang)) continue;
    out.push({ body, start: m.index + m[0].indexOf(body) });
  }
  const open = text.search(/[{[]/);
  if (open >= 0) {
    const close = Math.max(text.lastIndexOf('}'), text.lastIndexOf(']'));
    out.push({ body: close > open ? text.slice(open, close + 1) : text.slice(open), start: open });
  }
  return out;
}

function tryParse(src: string): { ok: true; value: unknown; repaired: boolean } | { ok: false } {
  const body = src.trim().replace(/^[^{[]*/, '');
  try {
    return { ok: true, value: JSON.parse(body), repaired: false };
  } catch {
    /* fall through to repairs */
  }
  // Smart double quotes used as delimiters (Notes, WhatsApp, Word). Apostrophes (’) are left alone.
  const straight = body.replace(/[“”„‟″]/g, '"');
  for (const s of [body, straight]) {
    try {
      return { ok: true, value: JSON5.parse(s), repaired: true };
    } catch {
      /* next */
    }
  }
  return { ok: false };
}

/**
 * Closes off JSON that stops mid-way (ChatGPT ran out of room). Walks back through
 * the positions where an array element or object ended and closes the brackets that
 * were still open there, newest first, until something parses.
 */
function repairTruncated(src: string): unknown | undefined {
  const text = src.replace(/[“”„‟″]/g, '"');
  const stack: string[] = [];
  const cuts: Array<{ at: number; closers: string }> = [];
  let inStr: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inStr) {
      if (c === '\\') i++;
      else if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'") inStr = c;
    else if (c === '{' || c === '[') stack.push(c === '{' ? '}' : ']');
    else if (c === '}' || c === ']') {
      stack.pop();
      if (stack.length) cuts.push({ at: i + 1, closers: [...stack].reverse().join('') });
    }
  }
  if (!stack.length && !inStr) return undefined; // not truncated, just broken
  for (const cut of cuts.reverse().slice(0, 50)) {
    try {
      return JSON5.parse(text.slice(0, cut.at).replace(/,\s*$/, '') + cut.closers);
    } catch {
      /* try an earlier cut */
    }
  }
  return undefined;
}

const isContainer = (v: unknown) => v !== null && typeof v === 'object';

/** First JSON object/array found in the text, repaired if needed. */
export function extractJson(text: string): Extracted | null {
  for (const c of candidates(text)) {
    const r = tryParse(c.body);
    if (r.ok && isContainer(r.value)) {
      return { value: r.value, repaired: r.repaired, truncated: false, span: [c.start, c.start + c.body.length] };
    }
    const body = c.body.trim().replace(/^[^{[]*/, '');
    const fixed = repairTruncated(body);
    if (isContainer(fixed)) {
      return { value: fixed, repaired: true, truncated: true, span: [c.start, c.start + c.body.length] };
    }
  }
  return null;
}
