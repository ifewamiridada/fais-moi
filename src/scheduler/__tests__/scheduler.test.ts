import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { parsePlan } from '../../parser';
import type { NotifDraft } from '../../parser/types';
import {
  createPlan,
  getOccurrence,
  getPlan,
  getSettings,
  listNotifs,
  listOccurrencesOn,
  listPlans,
  migrate,
  pausePlan,
  planHistory,
  resumePlan,
  setOccurrenceState,
  setPlanQuietUntil,
  setPlanSkippedDate,
  updateNotif,
  updatePlan,
  updateSettings,
  type Db,
  type Plan,
} from '../../db';
import { openNodeDb } from '../../db/__tests__/nodeDb';
import { expand, firesBefore } from '../expand';
import { handleAction } from '../actions';
import { ACTION } from '../notifier';
import { reconcile } from '../reconcile';
import { KEEPALIVE_BODY, MAX_SCHEDULED, NUDGE_AFTER, OS_LIMIT, SNOOZE_FOR } from '../window';
import { wallClock, zonedTime } from '../tz';
import { parseOn } from '../../parser/rules';
import { fakeNotifier } from './fakeNotifier';

const TZ = 'Africa/Lagos';
const MIN = 60_000;
const at = (date: string, hm: string) => zonedTime(date, hm, TZ);
/** Monday 28 Sep 2026, 07:00 in Lagos. */
const NOW = at('2026-09-28', '07:00');
const OPTS = { now: NOW, deviceTz: TZ };

let db: Db;
beforeEach(async () => {
  db = openNodeDb();
  await migrate(db);
});

const notif = (over: Partial<NotifDraft>): NotifDraft => ({
  id: over.title?.toLowerCase() ?? 'n',
  title: 'N',
  icon: 'spark',
  at: '09:00',
  on: 'daily',
  priority: 'gentle',
  optional: false,
  onMiss: 'none',
  enabled: true,
  messages: ['m1', 'm2', 'm3'],
  ...over,
});

async function makePlan(notifs: NotifDraft[], over: Partial<Parameters<typeof createPlan>[1]> = {}): Promise<Plan> {
  return createPlan(
    db,
    { title: 'Test plan', start: '2026-09-28', days: 30, tz: TZ, perDay: 6, quiet: { start: '22:30', end: '06:30' }, ...over },
    notifs,
    NOW,
  );
}

async function expandNow(opts: { horizonDays?: number; now?: number } = {}) {
  const all = await listPlans(db);
  const notifs = (await Promise.all(all.map((p) => listNotifs(db, p.id)))).flat();
  return expand({
    plans: all,
    notifs,
    settings: await getSettings(db),
    now: opts.now ?? NOW,
    horizonDays: opts.horizonDays ?? 7,
    deviceTz: TZ,
  });
}

const local = (t: number) => {
  const w = wallClock(t, TZ);
  return `${w.date} ${w.hm}`;
};

describe('firesBefore (message rotation)', () => {
  it('counts rule fires since the plan started', () => {
    expect(firesBefore(parseOn('daily')!, '2026-09-28', '2026-09-28')).toBe(0);
    expect(firesBefore(parseOn('daily')!, '2026-09-28', '2026-10-05')).toBe(7);
    // Mon 28 Sep start; Saturdays before Mon 12 Oct: 3 Oct, 10 Oct.
    expect(firesBefore(parseOn('sat')!, '2026-09-28', '2026-10-12')).toBe(2);
    expect(firesBefore(parseOn('weekdays')!, '2026-09-28', '2026-10-09')).toBe(9);
  });
});

describe('expand', () => {
  it('expands rules over the horizon with rotating messages', async () => {
    await makePlan([notif({ title: 'Breakfast', at: '08:00' }), notif({ title: 'Prep', at: '10:00', on: 'sat' })]);
    const c = await expandNow({ horizonDays: 7 });
    expect(c).toHaveLength(8); // 7 breakfasts + 1 Saturday
    expect(local(c[0]!.fireAt)).toBe('2026-09-28 08:00');
    expect(c.filter((x) => x.localDate === '2026-10-03').map((x) => local(x.fireAt))).toEqual([
      '2026-10-03 08:00',
      '2026-10-03 10:00',
    ]);
    expect(c.slice(0, 4).map((x) => x.messageIndex)).toEqual([0, 1, 2, 3]);
  });

  it('only returns future times', async () => {
    await makePlan([notif({ at: '06:00' }), notif({ title: 'Later', at: '12:00' })]);
    const c = await expandNow({ horizonDays: 1 });
    expect(c.map((x) => local(x.fireAt))).toEqual(['2026-09-28 12:00']);
  });

  it('respects plan dates', async () => {
    await makePlan([notif({})], { start: '2026-09-30', days: 2 });
    const c = await expandNow({ horizonDays: 7 });
    expect(c.map((x) => x.localDate)).toEqual(['2026-09-30', '2026-10-01']);
  });

  it('Skip today, Quiet till, weekend start', async () => {
    const p = await makePlan([notif({ at: '08:00' })]);
    await setPlanSkippedDate(db, p.id, '2026-09-28');
    await setPlanQuietUntil(db, p.id, at('2026-09-29', '12:00'));
    await updatePlan(db, p.id, { weekendStart: '09:30' });
    const c = await expandNow({ horizonDays: 7 });
    expect(c.map((x) => local(x.fireAt)).slice(0, 5)).toEqual([
      '2026-09-30 08:00',
      '2026-10-01 08:00',
      '2026-10-02 08:00',
      '2026-10-03 09:30',
      '2026-10-04 09:30',
    ]);
  });

  it('quiet hours drop notifs unless they are critical and "Can\'t miss breaks quiet" is on', async () => {
    await makePlan([notif({ title: 'Late', at: '23:00' }), notif({ title: 'Meds', at: '23:15', priority: 'critical' })]);
    let c = await expandNow({ horizonDays: 1 });
    expect(c.map((x) => local(x.fireAt))).toEqual(['2026-09-28 23:15']);
    await updateSettings(db, { criticalBreaksQuiet: false });
    c = await expandNow({ horizonDays: 1 });
    expect(c).toEqual([]);
  });

  it('global quiet hours apply on top of the plan', async () => {
    await makePlan([notif({ at: '21:00' })]);
    await updateSettings(db, { quiet: { start: '20:00', end: '07:00' } });
    expect(await expandNow({ horizonDays: 2 })).toEqual([]);
  });

  it('paused plans and Pause everything', async () => {
    const p = await makePlan([notif({ at: '08:00' })]);
    await pausePlan(db, p.id, at('2026-09-30', '00:00'));
    expect((await expandNow({ horizonDays: 4 })).map((x) => x.localDate)).toEqual(['2026-09-30', '2026-10-01']);
    await pausePlan(db, p.id, null);
    expect(await expandNow({ horizonDays: 4 })).toEqual([]);
    await resumePlan(db, p.id);
    await updateSettings(db, { pause: { until: at('2026-10-01', '00:00') } });
    expect((await expandNow({ horizonDays: 4 })).map((x) => x.localDate)).toEqual(['2026-10-01']);
    await updateSettings(db, { pause: { until: null } });
    expect(await expandNow({ horizonDays: 4 })).toEqual([]);
  });

  it('per-plan cap keeps the most important, counting times already past today', async () => {
    await makePlan(
      [
        notif({ title: 'Early', at: '06:45' }),
        notif({ title: 'A', at: '09:00', optional: true }),
        notif({ title: 'B', at: '10:00', priority: 'silent' }),
        notif({ title: 'C', at: '11:00', priority: 'critical' }),
      ],
      { perDay: 2, quiet: { start: '23:00', end: '06:00' } },
    );
    const today = (await expandNow({ horizonDays: 1 })).map((x) => local(x.fireAt));
    // Kept: C (critical) and Early (required gentle, already past) → only C is still to come.
    expect(today).toEqual(['2026-09-28 11:00']);
  });

  it('global daily cap works across plans', async () => {
    await makePlan([notif({ title: 'A', at: '09:00' }), notif({ title: 'B', at: '10:00' })]);
    await makePlan([notif({ title: 'C', at: '11:00', priority: 'critical' })], { title: 'Other' });
    await updateSettings(db, { dailyCap: 2 });
    const today = (await expandNow({ horizonDays: 1 })).map((x) => local(x.fireAt));
    expect(today).toEqual(['2026-09-28 09:00', '2026-09-28 11:00']);
  });
});

describe('reconcile', () => {
  async function startFixture() {
    const r = parsePlan(readFileSync(join(__dirname, '../../parser/__fixtures__/01-clean-v1.md'), 'utf8'), {
      today: '2026-09-28',
      deviceTz: TZ,
    });
    return createPlan(db, r.plan, r.notifs, NOW);
  }

  it('fills at most 60 slots plus the keep-alive, soonest first, never above the iOS limit', async () => {
    await startFixture();
    const { notifier, state } = fakeNotifier();
    const res = await reconcile(db, notifier, OPTS);
    expect(res.status).toBe('scheduled');
    expect(state.scheduled).toHaveLength(MAX_SCHEDULED + 1);
    expect(state.scheduled.length).toBeLessThanOrEqual(OS_LIMIT);
    const times = state.scheduled.map((n) => n.fireAt);
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(times[0]).toBeGreaterThan(NOW);

    const last = state.scheduled[state.scheduled.length - 1]!;
    expect(last).toMatchObject({ id: 'keepalive', body: KEEPALIVE_BODY, withActions: false });
    expect(last.fireAt).toBe(state.scheduled[MAX_SCHEDULED - 1]!.fireAt + MIN);

    const first = state.scheduled[0]!;
    expect(first).toMatchObject({
      title: 'Breakfast',
      subtitle: '30-Day PCOS Wellness',
      body: 'Start with a protein-rich breakfast.',
      withActions: true,
      data: { kind: 'main' },
    });
    expect((await getOccurrence(db, first.data.occurrenceId!))!.osNotificationId).toBe(`os-${first.id}`);
  });

  it('is idempotent: same schedule, same rows', async () => {
    await startFixture();
    const { notifier, state } = fakeNotifier();
    await reconcile(db, notifier, OPTS);
    const first = state.scheduled.map((n) => [n.id, n.fireAt]);
    const rows = await db.getAllAsync<{ id: number }>('SELECT id FROM occurrence ORDER BY id', []);
    await reconcile(db, notifier, OPTS);
    expect(state.scheduled.map((n) => [n.id, n.fireAt])).toEqual(first);
    expect(await db.getAllAsync<{ id: number }>('SELECT id FROM occurrence ORDER BY id', [])).toEqual(rows);
    expect(state.cancelCalls).toBe(2);
  });

  it('an edit drops stale occurrences and schedules the new time', async () => {
    const p = await makePlan([notif({ title: 'Walk', at: '09:00' })]);
    const { notifier, state } = fakeNotifier();
    await reconcile(db, notifier, OPTS);
    const [walk] = await listNotifs(db, p.id);
    await updateNotif(db, walk!.id, { at: '18:00' });
    await reconcile(db, notifier, OPTS);
    const times = state.scheduled.filter((n) => n.data.kind === 'main').map((n) => local(n.fireAt));
    expect(times.every((t) => t.endsWith('18:00'))).toBe(true);
    const nine = await db.getFirstAsync<{ c: number }>(
      `SELECT COUNT(*) AS c FROM occurrence WHERE fire_at = ?`,
      [at('2026-09-29', '09:00')],
    );
    expect(nine?.c).toBe(0);
  });

  it('keeps a future occurrence the user skipped from Today', async () => {
    await makePlan([notif({ title: 'Walk', at: '09:00' })]);
    const { notifier, state } = fakeNotifier();
    await reconcile(db, notifier, OPTS);
    const today = await listOccurrencesOn(db, '2026-09-28');
    await setOccurrenceState(db, today[0]!.id, 'skipped', NOW);
    await reconcile(db, notifier, OPTS);
    expect((await getOccurrence(db, today[0]!.id))!.state).toBe('skipped');
    expect(state.scheduled.some((n) => n.data.occurrenceId === today[0]!.id)).toBe(false);
  });

  it('without permission: cancels everything and leaves plans alone', async () => {
    const p = await startFixture();
    const { notifier, state } = fakeNotifier();
    await reconcile(db, notifier, OPTS);
    state.granted = false;
    const res = await reconcile(db, notifier, OPTS);
    expect(res).toEqual({ status: 'no-permission', scheduled: [] });
    expect(state.scheduled).toEqual([]);
    expect((await getPlan(db, p.id))!.status).toBe('active');
    state.granted = true;
    expect((await reconcile(db, notifier, OPTS)).scheduled).toHaveLength(MAX_SCHEDULED + 1);
  });

  it('schedules one nudge 30 min after notifs set to nudge once', async () => {
    await makePlan([notif({ title: 'Meds', at: '09:00', onMiss: 'nudge_once' })], { days: 1 });
    const { notifier, state } = fakeNotifier();
    await reconcile(db, notifier, OPTS);
    expect(state.scheduled.map((n) => [n.data.kind, local(n.fireAt)])).toEqual([
      ['main', '2026-09-28 09:00'],
      ['nudge', '2026-09-28 09:30'],
    ]);
    // After it fires, the nudge is still scheduled until it's due…
    await reconcile(db, notifier, { ...OPTS, now: at('2026-09-28', '09:10') });
    expect(state.scheduled.map((n) => n.data.kind)).toEqual(['nudge']);
    // …and the occurrence is missed once the nudge window passes with no action.
    await reconcile(db, notifier, { ...OPTS, now: at('2026-09-28', '09:31') });
    expect(state.scheduled).toEqual([]);
    expect((await listOccurrencesOn(db, '2026-09-28'))[0]!.state).toBe('missed');
  });

  it('no keep-alive once every plan ends inside the window', async () => {
    await makePlan([notif({})], { days: 3 });
    const { notifier, state } = fakeNotifier();
    await reconcile(db, notifier, OPTS);
    expect(state.scheduled.map((n) => n.id)).not.toContain('keepalive');
    expect(state.scheduled).toHaveLength(3);
  });

  it('keep-alive at the end of the expanded days when the plan goes on', async () => {
    await makePlan([notif({ on: 'sun' })], { days: null });
    const { notifier, state } = fakeNotifier();
    await reconcile(db, notifier, { ...OPTS, horizonDays: 7 });
    expect(state.scheduled.map((n) => [n.id.replace(/\d+/, '#'), local(n.fireAt)])).toEqual([
      ['occ-#', '2026-10-04 09:00'],
      ['keepalive', '2026-10-05 00:00'],
    ]);
  });

  it('ends finished plans and clears an expired Pause everything', async () => {
    await makePlan([notif({})], { start: '2026-09-01', days: 5 });
    await updateSettings(db, { pause: { until: NOW - 1 } });
    const { notifier, state } = fakeNotifier();
    await reconcile(db, notifier, OPTS);
    expect(state.scheduled).toEqual([]);
    expect((await getSettings(db)).pause).toBeNull();
    expect((await listPlans(db, 'ended')).length).toBe(1);
  });
});

describe('notification actions', () => {
  async function fired() {
    await makePlan([notif({ title: 'Walk', at: '07:30', onMiss: 'nudge_once' })], { days: 2 });
    const { notifier, state } = fakeNotifier();
    await reconcile(db, notifier, OPTS);
    const n = state.scheduled.find((x) => x.data.kind === 'main')!;
    const t = n.fireAt + 2 * MIN; // the user answers two minutes after it fired
    return { notifier, state, n, t };
  }

  it('Done marks the occurrence and drops its nudge', async () => {
    const { notifier, state, n, t } = await fired();
    expect(await handleAction(db, ACTION.done, n.data, t)).toBe('done');
    expect(await getOccurrence(db, n.data.occurrenceId!)).toMatchObject({ state: 'done', actedAt: t });
    await reconcile(db, notifier, { ...OPTS, now: t });
    expect(state.scheduled.some((x) => x.data.occurrenceId === n.data.occurrenceId)).toBe(false);
    expect(await handleAction(db, ACTION.done, n.data, t + 1)).toBe('ignored');
  });

  it('Skip today marks it skipped', async () => {
    const { n, t } = await fired();
    expect(await handleAction(db, ACTION.skip, n.data, t)).toBe('skipped');
    expect((await getOccurrence(db, n.data.occurrenceId!))!.state).toBe('skipped');
  });

  it('In 30 min schedules a one-off 30 minutes later, once', async () => {
    const { notifier, state, n, t } = await fired();
    expect(await handleAction(db, ACTION.snooze, n.data, t)).toBe('snoozed');
    expect(await handleAction(db, ACTION.snooze, n.data, t)).toBe('ignored'); // duplicate delivery
    await reconcile(db, notifier, { ...OPTS, now: t });
    const snooze = state.scheduled.filter((x) => x.data.kind === 'snooze');
    expect(snooze).toHaveLength(1);
    expect(snooze[0]).toMatchObject({ fireAt: t + SNOOZE_FOR, title: 'Walk', body: 'm1', data: { occurrenceId: n.data.occurrenceId } });
    expect(state.scheduled.some((x) => x.data.kind === 'nudge' && x.data.occurrenceId === n.data.occurrenceId)).toBe(false);

    // Snoozing the snooze moves it on again; Done on it resolves the original.
    const t2 = t + SNOOZE_FOR + MIN;
    expect(await handleAction(db, ACTION.snooze, snooze[0]!.data, t2)).toBe('snoozed');
    await reconcile(db, notifier, { ...OPTS, now: t2 });
    const again = state.scheduled.find((x) => x.data.kind === 'snooze')!;
    expect(again.fireAt).toBe(t2 + SNOOZE_FOR);
    expect(await handleAction(db, ACTION.done, again.data, t2 + SNOOZE_FOR)).toBe('done');
    expect((await getOccurrence(db, n.data.occurrenceId!))!.state).toBe('done');
    await reconcile(db, notifier, { ...OPTS, now: t2 + SNOOZE_FOR });
    expect(state.scheduled.some((x) => x.data.kind === 'snooze')).toBe(false);
  });

  it('Done from a snooze still in Notification Center clears the pending snooze', async () => {
    const { notifier, state, n, t } = await fired();
    await handleAction(db, ACTION.snooze, n.data, t);
    await handleAction(db, ACTION.done, n.data, t + 5 * MIN); // the original notification's Done
    await reconcile(db, notifier, { ...OPTS, now: t + 5 * MIN });
    expect(state.scheduled.some((x) => x.data.kind === 'snooze')).toBe(false);
  });

  it('acting on the nudge resolves the original', async () => {
    const { notifier, state, n } = await fired();
    const nudge = state.scheduled.find((x) => x.data.kind === 'nudge')!;
    expect(nudge.fireAt).toBe(n.fireAt + NUDGE_AFTER);
    await reconcile(db, notifier, { ...OPTS, now: nudge.fireAt + MIN });
    expect(await handleAction(db, ACTION.done, nudge.data, nudge.fireAt + MIN)).toBe('done');
    expect((await getOccurrence(db, n.data.occurrenceId!))!.state).toBe('done');
  });

  it('tapping the notification or the keep-alive just opens the app', async () => {
    const { n } = await fired();
    expect(await handleAction(db, 'expo.modules.notifications.actions.DEFAULT', n.data)).toBe('opened');
    expect(await handleAction(db, ACTION.done, { kind: 'keepalive' })).toBe('opened');
    expect(await handleAction(db, ACTION.done, { kind: 'main', occurrenceId: 9999 })).toBe('ignored');
  });

  it('snoozed and done show in the 7-day history', async () => {
    const { n, t } = await fired();
    await handleAction(db, ACTION.done, n.data, t);
    const h = await planHistory(db, 1, '2026-09-22', '2026-09-28');
    expect(h.total.done).toBe(1);
  });
});
