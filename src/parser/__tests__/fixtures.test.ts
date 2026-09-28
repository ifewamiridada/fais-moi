import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { blockingIssues, buildFixItPrompt, parsePlan, PlanV1, serializePlan } from '..';
import type { ParseResult } from '../types';

const OPTS = { today: '2026-09-28', deviceTz: 'Africa/Lagos' };
const fixture = (name: string) => readFileSync(join(__dirname, '../__fixtures__', name), 'utf8');
const parse = (name: string) => parsePlan(fixture(name), OPTS);
const codes = (r: ParseResult) => r.issues.map((i) => i.code);
const summary = (r: ParseResult) => r.notifs.map((n) => `${n.title} ${n.at} ${n.on}`);

describe('JSON fixtures', () => {
  it('01 clean fais-moi v1', () => {
    const r = parse('01-clean-v1.md');
    expect(r.status).toBe('ok');
    expect(r.source).toBe('fais-moi');
    expect(r.issues).toEqual([]);
    expect(r.plan).toEqual({
      title: '30-Day PCOS Wellness',
      start: '2026-09-28',
      days: 30,
      tz: 'Africa/Lagos',
      perDay: 6,
      quiet: { start: '22:30', end: '06:30' },
    });
    expect(r.notifs).toHaveLength(7);
    expect(r.notifs[0]).toEqual({
      id: 'breakfast',
      title: 'Breakfast',
      icon: 'sun',
      at: '08:00',
      on: 'daily',
      priority: 'gentle',
      optional: false,
      onMiss: 'none',
      enabled: true,
      messages: [
        'Start with a protein-rich breakfast.',
        'Eggs, beans or yoghurt — pick one before 9.',
        'Add some fibre: oats or fruit.',
      ],
    });
    expect(r.notifs.find((n) => n.id === 'hydration')).toMatchObject({ on: 'weekdays', optional: true, icon: 'drop' });
    expect(r.notifs.find((n) => n.id === 'faith')?.priority).toBe('critical');
    expect(r.notifs.find((n) => n.id === 'meal-prep')).toMatchObject({ on: 'sat', icon: 'bowl' }) // no icon given: hinted from "meal";
  });

  it('02 prose around a fenced block is ignored', () => {
    const r = parse('02-prose-around-fence.md');
    expect(r.status).toBe('ok');
    expect(r.source).toBe('fais-moi');
    expect(r.issues).toEqual([]);
    expect(r.plan.title).toBe('IELTS in 30 days');
    expect(summary(r)).toEqual(['Vocabulary 07:15 weekdays', 'Listening 19:00 mon,wed,fri', 'Mock test 09:00 2026-10-17']);
  });

  it('03 trailing commas and comments; no days → ongoing', () => {
    const r = parse('03-trailing-commas-comments.md');
    expect(r.status).toBe('ok');
    expect(r.plan.days).toBeNull();
    expect(r.notifs.map((n) => n.id)).toEqual(['morning-prayer', 'sabbath']);
    expect(r.notifs[0]!.messages).toHaveLength(2);
    expect(r.notifs[1]!.on).toBe('sun');
  });

  it('04 smart quotes as delimiters', () => {
    const r = parse('04-smart-quotes.txt');
    expect(r.status).toBe('ok');
    expect(r.plan).toMatchObject({ title: 'Sleep reset', start: '2026-09-29', days: 14 });
    expect(r.notifs[0]!.messages[0]).toBe('Phone on the charger — outside the bedroom.');
  });

  it('05 field aliases (time, repeat, reminders, message, length)', () => {
    const r = parse('05-aliases-time-repeat.md');
    expect(r.status).toBe('ok');
    expect(r.source).toBe('json');
    expect(r.plan).toMatchObject({ start: '2026-09-28', days: 30 });
    expect(summary(r)).toEqual(['Breakfast 08:00 daily', 'Meal prep 10:00 sat', 'Stretch 17:30 weekdays']);
    expect(r.notifs[1]).toMatchObject({ priority: 'critical', messages: ['Prep lunches for the week.'] });
    expect(r.notifs[2]!.icon).toBe('move');
  });

  it('06 "json / Copy code" paste from the web UI, no fences', () => {
    const r = parse('06-copy-code-no-fence.txt');
    expect(r.status).toBe('ok');
    expect(r.source).toBe('fais-moi');
    expect(r.notifs.map((n) => n.id)).toEqual(['water-am', 'water-pm']);
  });

  it('07 cut-off JSON keeps the complete notifs and says so', () => {
    const r = parse('07-truncated.md');
    expect(r.status).toBe('ok');
    expect(r.plan.title).toBe('Couch to 5K');
    expect(r.notifs.map((n) => n.id)).toEqual(['run', 'rest']);
    expect(codes(r)).toEqual(['truncated']);
    expect(buildFixItPrompt(r)).toContain('cut off');
  });

  it('08 over the daily cap: lowest-priority notif moves, with an explanation', () => {
    const r = parse('08-over-cap.json');
    expect(r.status).toBe('ok');
    const over = r.issues.filter((i) => i.code === 'over-cap');
    expect(over).toHaveLength(1);
    expect(over[0]).toMatchObject({ notifId: 'hydration', fixed: true, severity: 'warning' });
    expect(over[0]!.message).toBe(
      'Saturdays & Sundays had 7 notifs — over your limit of 6. We moved Hydration to weekdays only.',
    );
    expect(r.notifs.find((n) => n.id === 'hydration')!.on).toBe('weekdays');
    expect(r.notifs.find((n) => n.id === 'meal-prep')!.on).toBe('sat');
  });

  it('09 quiet hours flagged, duplicate ids suffixed, empty messages are an error', () => {
    const r = parse('09-quiet-and-dupes.json');
    expect(r.status).toBe('partial');
    expect(r.notifs.map((n) => n.id)).toEqual(['journal', 'journal-2', 'early', 'empty']);
    const quiet = r.issues.filter((i) => i.code === 'quiet-hours');
    expect(quiet.map((i) => i.notifId)).toEqual(['journal', 'early']);
    expect(quiet[0]!.message).toBe('Journal at 11:15 PM falls in quiet hours (10:30 PM – 6:30 AM).');
    expect(quiet.every((i) => !i.fixed)).toBe(true);
    expect(r.issues.find((i) => i.code === 'duplicate-id')).toMatchObject({ notifId: 'journal-2', fixed: true });
    expect(r.issues.find((i) => i.code === 'messages-empty')).toMatchObject({ notifId: 'empty', severity: 'error' });
    expect(blockingIssues(r).map((i) => i.notifId)).toEqual(['empty']);
  });

  it('14 plan nested under "plan", day arrays, message objects, bad time and rule', () => {
    const r = parse('14-nested-plan-object.md');
    expect(r.status).toBe('partial');
    expect(r.plan).toMatchObject({ title: 'Study plan', start: '2026-10-01', days: 14, tz: 'Europe/London' });
    expect(r.notifs[0]).toMatchObject({ on: 'mon,tue,wed,thu', messages: ['Chapter 1, notes only.', 'Chapter 2.'] });
    expect(r.notifs[1]).toMatchObject({ at: null, on: 'daily' });
    expect(codes(r)).toEqual(['time-invalid', 'on-invalid']);
    expect(buildFixItPrompt(r)).toBe(
      'Rewrite your last answer as one fais-moi v1 json block. Give “Review” a 24-hour time like 08:00. ' +
        'Give “Review” repeat days: daily, weekdays, weekends or days like mon,wed,fri.',
    );
  });

  it('15 bare array of notifs', () => {
    const r = parse('15-top-level-array.json');
    expect(r.status).toBe('ok');
    expect(r.source).toBe('json');
    expect(r.plan).toMatchObject({ title: 'My plan', start: '2026-09-28', days: null });
    expect(r.notifs.map((n) => n.id)).toEqual(['vitamins', 'water']);
    expect(codes(r)).toEqual(['plan-title-missing', 'start-missing']);
  });
});

describe('text fallback fixtures', () => {
  it('10 the "Couldn\'t read plan" case: 3 found, 1 with no time, guessed dates', () => {
    const r = parse('10-text-parsefail.md');
    expect(r.status).toBe('partial');
    expect(r.source).toBe('text');
    expect(r.plan).toMatchObject({ title: 'Evening routine', start: '2026-09-28', days: 30 });
    expect(summary(r)).toEqual([
      'Dinner 19:30 daily',
      'Tidy up 20:30 daily',
      'Read 21:15 daily',
      'Evening wind-down null daily',
    ]);
    expect(r.notifs.filter((n) => n.at)).toHaveLength(3);
    expect(r.issues.map((i) => i.message)).toEqual([
      'There was no fais-moi code block, so we read the reminders line by line.',
      'Intro and outro text skipped.',
      "No start date or length — we'd guess today, 30 days.",
      '“Evening wind-down” has no time.',
    ]);
    expect(buildFixItPrompt(r)).toBe(
      'Rewrite your last answer as one fais-moi v1 json block. Start 2026-09-28, 30 days. Give “Evening wind-down” a time.',
    );
  });

  it('11 markdown headings, bold, numbered lines, day sections, plan details', () => {
    const r = parse('11-text-lines.md');
    expect(r.status).toBe('ok');
    expect(r.plan).toMatchObject({ title: '30-Day PCOS Wellness', start: '2026-09-28', days: 30 });
    expect(summary(r)).toEqual([
      'Breakfast 08:00 daily',
      'Lunch check 13:00 daily',
      'Mental reset 20:30 daily',
      'Meal prep 10:00 sat',
    ]);
    expect(r.notifs[2]!.messages).toEqual(['What can you release?']);
    expect(codes(r)).toEqual(['no-json', 'prose-skipped']);
  });

  it('12 markdown table with a days column', () => {
    const r = parse('12-markdown-table.md');
    expect(summary(r)).toEqual(['Wake & stretch 07:00 daily', 'Lunch walk 12:30 weekdays', 'Weekly review 18:00 sun']);
    expect(r.notifs[1]!.messages).toEqual(['Ten minutes outside after lunch.']);
  });

  it('13 day-by-day listing merges into rotating messages', () => {
    const r = parse('13-day-by-day.md');
    expect(r.notifs).toHaveLength(2);
    expect(r.notifs[0]).toMatchObject({
      title: 'Breakfast',
      at: '08:00',
      messages: ['Eggs and spinach to start.', 'Greek yoghurt with berries.', 'Beans on toast.'],
    });
    expect(r.notifs[1]!.messages).toHaveLength(3);
  });

  it('16 a refusal / no plan at all fails cleanly', () => {
    const r = parse('16-garbage.txt');
    expect(r.status).toBe('failed');
    expect(r.source).toBe('none');
    expect(r.notifs).toEqual([]);
    expect(codes(r)).toEqual(['no-notifs']);
  });
});

describe('round trip', () => {
  it.each(['01-clean-v1.md', '05-aliases-time-repeat.md', '11-text-lines.md', '13-day-by-day.md'])(
    '%s → serialize → parse is stable and schema-valid',
    (name) => {
      const first = parse(name);
      const doc = serializePlan(first.plan, first.notifs);
      expect(PlanV1.safeParse(doc).success).toBe(true);
      const second = parsePlan('```json\n' + JSON.stringify(doc, null, 2) + '\n```', OPTS);
      expect(second.source).toBe('fais-moi');
      expect(second.plan).toEqual(first.plan);
      expect(second.notifs).toEqual(first.notifs);
    },
  );
});
