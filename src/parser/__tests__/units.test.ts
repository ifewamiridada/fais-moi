import { describe, expect, it } from 'vitest';
import { buildPlanPrompt, describeOn, formatTime, messageFor, parseOn, parsePlan, parseTime, SCHEMA_TEXT } from '..';
import { extractJson } from '../extract';
import { formatOn } from '../rules';
import { inWindow, parseQuiet } from '../time';

const OPTS = { today: '2026-09-28', deviceTz: 'Africa/Lagos' };

describe('parseTime', () => {
  it.each([
    ['08:00', '08:00'],
    ['8:00', '08:00'],
    ['8:00 AM', '08:00'],
    ['8am', '08:00'],
    ['8 a.m.', '08:00'],
    ['12:00 AM', '00:00'],
    ['12 pm', '12:00'],
    ['8:30 PM', '20:30'],
    ['20.30', '20:30'],
    ['8h30', '08:30'],
    ['07:00:00', '07:00'],
    ['noon', '12:00'],
  ])('%s → %s', (input, out) => expect(parseTime(input)).toBe(out));

  it.each(['8', '25:00', '13pm', '8:75', 'morning', '', null, 8])('rejects %s', (input) => {
    expect(parseTime(input)).toBeNull();
  });

  it('formats for display', () => {
    expect(formatTime('00:05')).toBe('12:05 AM');
    expect(formatTime('13:00')).toBe('1:00 PM');
  });
});

describe('quiet hours', () => {
  const q = { start: '22:30', end: '06:30' };
  it('handles windows that cross midnight', () => {
    expect(inWindow('23:00', q)).toBe(true);
    expect(inWindow('02:00', q)).toBe(true);
    expect(inWindow('06:30', q)).toBe(false);
    expect(inWindow('22:29', q)).toBe(false);
    expect(inWindow('13:00', { start: '12:00', end: '14:00' })).toBe(true);
  });
  it('reads several spellings', () => {
    expect(parseQuiet('22:30-06:30')).toEqual(q);
    expect(parseQuiet('10:30 PM – 6:30 AM')).toEqual(q);
    expect(parseQuiet({ from: '22:30', to: '6:30am' })).toEqual(q);
    expect(parseQuiet('late')).toBeNull();
  });
});

describe('on rules', () => {
  it.each([
    ['daily', 'daily'],
    ['Every day', 'daily'],
    ['weekdays', 'weekdays'],
    ['Mon–Fri', 'weekdays'],
    ['Monday to Friday', 'weekdays'],
    ['weekends', 'weekends'],
    ['sat', 'sat'],
    ['Saturdays', 'sat'],
    ['every Saturday', 'sat'],
    ['mon, wed & fri', 'mon,wed,fri'],
    ['fri-mon', 'mon,fri,sat,sun'],
    ['sun,mon,tue,wed,thu,fri,sat', 'daily'],
    ['2026-10-03', '2026-10-03'],
  ])('%s → %s', (input, out) => expect(formatOn(parseOn(input)!)).toBe(out));

  it('accepts arrays', () => expect(formatOn(parseOn(['Sat', 'sunday'])!)).toBe('weekends'));

  it.each(['fortnightly', 'twice a week', '2026-02-30', '', 3])('rejects %s', (input) => {
    expect(parseOn(input)).toBeNull();
  });

  it.each([
    ['daily', 'Daily'],
    ['weekdays', 'Weekdays'],
    ['sat', 'Saturdays'],
    ['sat,sun', 'Weekends'],
    ['tue,thu', 'Tuesdays & Thursdays'],
    ['mon,wed,fri', 'Mon, Wed & Fri'],
    ['2026-10-03', '3 Oct'],
  ])('describes %s as %s', (rule, label) => expect(describeOn(rule)).toBe(label));
});

describe('message rotation', () => {
  it('Nth occurrence uses messages[(N-1) % len]', () => {
    const m = ['a', 'b', 'c'];
    expect([1, 2, 3, 4, 5, 7].map((n) => messageFor(m, n))).toEqual(['a', 'b', 'c', 'a', 'b', 'a']);
    expect(messageFor([], 1)).toBe('');
  });
});

describe('extractJson', () => {
  it('prefers the fenced block over braces in prose', () => {
    const r = extractJson('Use {curly} braces?\n```json\n{"a": 1}\n```\nDone {x}');
    expect(r?.value).toEqual({ a: 1 });
    expect(r?.repaired).toBe(false);
  });
  it('repairs single quotes and unquoted keys', () => {
    expect(extractJson("{plan: 'x', notifs: []}")?.value).toEqual({ plan: 'x', notifs: [] });
  });
  it('keeps smart quotes that are inside valid JSON strings', () => {
    expect(extractJson('{"m": "Say “no” to sugar"}')?.value).toEqual({ m: 'Say “no” to sugar' });
  });
  it('returns null when there is nothing JSON-like', () => {
    expect(extractJson('just words')).toBeNull();
  });
});

describe('parsePlan edge cases', () => {
  const doc = (notifs: object[], extra: object = {}) =>
    JSON.stringify({ format: 'fais-moi/1', plan: 'P', start: '2026-09-28', days: 30, notifs, ...extra });

  it('never throws on empty input', () => {
    const r = parsePlan('', OPTS);
    expect(r.status).toBe('failed');
    expect(r.issues[0]!.message).toBe('Nothing to read yet.');
  });

  it('defaults optional fields and falls back to spark for unknown icons', () => {
    const r = parsePlan(doc([{ id: 'x', title: 'Thing', at: '09:00', icon: 'rocket', messages: ['go'] }]), OPTS);
    expect(r.notifs[0]).toMatchObject({ on: 'daily', icon: 'spark', priority: 'gentle', optional: false, enabled: true });
    expect(r.issues).toEqual([]);
  });

  it('uses defaults from New plan when the import has no limits', () => {
    const r = parsePlan(doc([{ id: 'x', title: 'T', at: '09:00', messages: ['m'] }]), {
      ...OPTS,
      defaults: { perDay: 3, quiet: { start: '23:00', end: '07:00' } },
    });
    expect(r.plan).toMatchObject({ perDay: 3, quiet: { start: '23:00', end: '07:00' } });
  });

  it('invalid tz falls back to the device tz with a note', () => {
    const r = parsePlan(doc([{ id: 'x', title: 'T', at: '09:00', messages: ['m'] }], { tz: 'Mars/Olympus' }), OPTS);
    expect(r.plan.tz).toBe('Africa/Lagos');
    expect(r.issues.map((i) => i.code)).toEqual(['tz-invalid']);
  });

  it('flags one-off dates outside the plan', () => {
    const r = parsePlan(doc([{ id: 'x', title: 'Exam', at: '09:00', on: '2026-12-25', messages: ['m'] }]), OPTS);
    expect(r.issues[0]).toMatchObject({ code: 'date-outside-plan', fixed: false, notifId: 'x' });
  });

  it('turns a notif off when it has no days left under the cap', () => {
    const notifs = [1, 2, 3].map((i) => ({ id: `n${i}`, title: `N${i}`, at: `1${i}:00`, on: 'sat', messages: ['m'] }));
    const r = parsePlan(doc(notifs, { limits: { per_day: 2 } }), OPTS);
    expect(r.notifs.map((n) => n.enabled)).toEqual([true, true, false]);
    expect(r.issues[0]!.message).toBe('Saturdays had 3 notifs — over your limit of 2. We turned off N3.');
  });

  it('prefers optional, then lower priority, when choosing what gives way', () => {
    const r = parsePlan(
      doc(
        [
          { id: 'a', title: 'A', at: '09:00', optional: true, messages: ['m'] },
          { id: 'b', title: 'B', at: '10:00', priority: 'silent', messages: ['m'] },
          { id: 'c', title: 'C', at: '11:00', priority: 'critical', messages: ['m'] },
        ],
        { limits: { per_day: 1 } },
      ),
      OPTS,
    );
    expect(r.notifs.map((n) => n.enabled)).toEqual([false, false, true]);
  });

  it('flags a one-off date that tips a day over the cap without moving anything', () => {
    const r = parsePlan(
      doc(
        [
          { id: 'a', title: 'A', at: '09:00', messages: ['m'] },
          { id: 'b', title: 'B', at: '10:00', on: '2026-10-03', messages: ['m'] },
        ],
        { limits: { per_day: 1 } },
      ),
      OPTS,
    );
    expect(r.issues.map((i) => i.code)).toEqual(['over-cap-date']);
    expect(r.issues[0]!.message).toBe('3 Oct has 2 notifs — over your limit of 1.');
    expect(r.notifs.every((n) => n.enabled)).toBe(true);
  });

  it('text: prose mentioning a time is not a reminder', () => {
    const r = parsePlan('Try to sleep at 10pm every night for best results.\n\n8:00 AM — Breakfast: Eat.', OPTS);
    expect(r.notifs.map((n) => n.title)).toEqual(['Breakfast']);
  });

  it('text: title-first lines and parenthesised days', () => {
    const r = parsePlan('- Meal prep (Saturdays) @ 10:00 — Prep lunches.\n- Breakfast (8:00 AM): Eggs.', OPTS);
    expect(r.notifs.map((n) => `${n.title} ${n.at} ${n.on}`)).toEqual(['Meal prep 10:00 sat', 'Breakfast 08:00 daily']);
  });

  it('text: tips after the list are not reminders', () => {
    const r = parsePlan('- 08:00 — Breakfast: Eat.\n\n**Tips:**\n- Consistency: Keep going.\n- Rest: Sleep well.', OPTS);
    expect(r.notifs.map((n) => n.title)).toEqual(['Breakfast']);
    expect(r.status).toBe('ok');
  });
});

describe('buildPlanPrompt', () => {
  it('fills the template', () => {
    const p = buildPlanPrompt({
      goal: 'Manage PCOS with food and movement',
      days: 30,
      startDate: '2026-09-28',
      wake: '06:30',
      sleep: '22:30',
      workStart: '09:00',
      workEnd: '17:00',
      perDay: 6,
      extra: 'I pray at 21:00.',
    });
    expect(p).toContain('Goal: Manage PCOS with food and movement\nLength: 30 days from 2026-09-28.');
    expect(p).toContain('My day: awake 06:30–22:30, work 09:00–17:00.');
    expect(p).toContain('Limit: no more than 6 reminders a day.\nAlso: I pray at 21:00.');
    expect(p.endsWith(SCHEMA_TEXT)).toBe(true);
  });

  it('handles ongoing plans, no work hours and no extra', () => {
    const p = buildPlanPrompt({ goal: 'Pray', days: null, startDate: '2026-09-28', wake: '06:00', sleep: '22:00', perDay: 3 });
    expect(p).toContain('Length: Ongoing, starting 2026-09-28.');
    expect(p).toContain('My day: awake 06:00–22:00.');
    expect(p).not.toContain('Also:');
  });

  it('the schema example itself parses as a clean plan', () => {
    const example = SCHEMA_TEXT.slice(SCHEMA_TEXT.indexOf('{'), SCHEMA_TEXT.lastIndexOf('}') + 1)
      .replace('YYYY-MM-DD', '2026-09-28')
      .replace('Area/City', 'Africa/Lagos');
    const r = parsePlan(example, OPTS);
    expect(r.status).toBe('ok');
    expect(r.source).toBe('fais-moi');
  });
});
