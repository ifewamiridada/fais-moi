import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { parsePlan, PlanV1, serializePlan } from '../../parser';
import {
  addNotif,
  createPlan,
  deletePendingFrom,
  deletePlan,
  duplicatePlan,
  getOccurrence,
  getPlan,
  getSettings,
  isPausedAll,
  listNotifs,
  listOccurrencesBetween,
  listOccurrencesOn,
  listPlans,
  loadPlanDraft,
  markMissed,
  migrate,
  pausePlan,
  planDay,
  planHistory,
  refreshPlanStatuses,
  resumePlan,
  SCHEMA_VERSION,
  setOccurrenceState,
  setPlanOnMiss,
  setPlanQuietUntil,
  setPlanSkippedDate,
  updateNotif,
  updatePlan,
  updateSettings,
  upsertOccurrence,
  ValidationError,
  type Db,
} from '..';
import { openNodeDb } from './nodeDb';

const OPTS = { today: '2026-09-28', deviceTz: 'Africa/Lagos' };
const NOW = Date.parse('2026-09-28T07:00:00Z'); // 08:00 in Lagos (UTC+1)
const HOUR = 3_600_000;
const fixture = (name: string) =>
  parsePlan(readFileSync(join(__dirname, '../../parser/__fixtures__', name), 'utf8'), OPTS);

let db: Db;
beforeEach(async () => {
  db = openNodeDb();
  await migrate(db);
});

async function startClean() {
  const r = fixture('01-clean-v1.md');
  return createPlan(db, r.plan, r.notifs, NOW);
}

describe('migrate', () => {
  it('creates the schema once and is safe to re-run', async () => {
    expect(await migrate(db)).toBe(SCHEMA_VERSION);
    const v = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
    expect(v?.user_version).toBe(SCHEMA_VERSION);
    const tables = await db.getAllAsync<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    );
    expect(tables.map((t) => t.name)).toEqual(['notif', 'occurrence', 'plan', 'settings']);
  });

  it('refuses a database from a newer app version', async () => {
    await db.execAsync(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
    await expect(migrate(db)).rejects.toThrow(/newer than this app/);
  });
});

describe('plans', () => {
  it('Start plan stores the parsed plan and its notifs in order', async () => {
    const plan = await startClean();
    expect(plan).toMatchObject({
      title: '30-Day PCOS Wellness',
      start: '2026-09-28',
      days: 30,
      tz: 'Africa/Lagos',
      perDay: 6,
      quiet: { start: '22:30', end: '06:30' },
      status: 'active',
      pausedUntil: null,
      createdAt: NOW,
    });
    const notifs = await listNotifs(db, plan.id);
    expect(notifs.map((n) => n.key)).toEqual(['breakfast', 'hydration', 'lunch', 'move', 'reset', 'faith', 'meal-prep']);
    expect(notifs[0]).toMatchObject({ title: 'Breakfast', at: '08:00', on: 'daily', icon: 'sun', sort: 0 });
    expect(notifs[0]!.messages).toHaveLength(3);
    expect(notifs[1]).toMatchObject({ optional: true, on: 'weekdays' });
  });

  it('round-trips to the same fais-moi v1 JSON (Adjust with ChatGPT)', async () => {
    const r = fixture('01-clean-v1.md');
    const plan = await createPlan(db, r.plan, r.notifs, NOW);
    const loaded = (await loadPlanDraft(db, plan.id))!;
    const doc = serializePlan(loaded.plan, loaded.notifs);
    expect(PlanV1.safeParse(doc).success).toBe(true);
    expect(doc).toEqual(serializePlan(r.plan, r.notifs));
  });

  it('keeps disabled notifs with no time, but refuses enabled ones', async () => {
    const r = fixture('10-text-parsefail.md');
    await expect(createPlan(db, r.plan, r.notifs, NOW)).rejects.toThrow(/needs a time/);
    expect(await listPlans(db)).toEqual([]); // rolled back

    const notifs = r.notifs.map((n) => (n.at ? n : { ...n, enabled: false }));
    const plan = await createPlan(db, r.plan, notifs, NOW);
    const stored = await listNotifs(db, plan.id);
    expect(stored.map((n) => [n.key, n.at, n.enabled])).toContainEqual(['evening-wind-down', null, false]);
  });

  it('refuses a plan with nothing switched on, and bad plan fields', async () => {
    const r = fixture('01-clean-v1.md');
    await expect(createPlan(db, r.plan, r.notifs.map((n) => ({ ...n, enabled: false })))).rejects.toThrow(
      ValidationError,
    );
    await expect(createPlan(db, { ...r.plan, tz: 'Mars/Base' }, r.notifs)).rejects.toThrow(/time zone/);
    await expect(createPlan(db, { ...r.plan, start: '2026-02-30' }, r.notifs)).rejects.toThrow(/start/);
    await expect(createPlan(db, { ...r.plan, perDay: 0 }, r.notifs)).rejects.toThrow(/perDay/);
  });

  it('updates settings from the Plan screen', async () => {
    const plan = await startClean();
    const updated = await updatePlan(db, plan.id, { perDay: 4, quiet: { start: '23:00', end: '07:00' }, weekendStart: '09:00' });
    expect(updated).toMatchObject({ perDay: 4, quiet: { start: '23:00', end: '07:00' }, weekendStart: '09:00', title: plan.title });
    expect((await updatePlan(db, plan.id, { weekendStart: null })).weekendStart).toBeNull();
    await expect(updatePlan(db, plan.id, { weekendStart: '9am' })).rejects.toThrow(/HH:MM/);
  });

  it('pause, resume, quiet till, skip today', async () => {
    const plan = await startClean();
    await pausePlan(db, plan.id, NOW + 24 * HOUR);
    expect(await getPlan(db, plan.id)).toMatchObject({ status: 'paused', pausedUntil: NOW + 24 * HOUR });
    expect((await listPlans(db, 'paused')).map((p) => p.id)).toEqual([plan.id]);
    await resumePlan(db, plan.id);
    expect(await getPlan(db, plan.id)).toMatchObject({ status: 'active', pausedUntil: null });

    await setPlanQuietUntil(db, plan.id, NOW + HOUR);
    await setPlanSkippedDate(db, plan.id, '2026-09-28');
    expect(await getPlan(db, plan.id)).toMatchObject({ quietUntil: NOW + HOUR, skippedDate: '2026-09-28' });
  });

  it('refreshPlanStatuses resumes expired pauses, ends finished plans, clears stale markers', async () => {
    const a = await startClean();
    const r = fixture('01-clean-v1.md');
    const b = await createPlan(db, { ...r.plan, title: 'Short', days: 3 }, r.notifs, NOW);
    const c = await createPlan(db, { ...r.plan, title: 'Paused forever' }, r.notifs, NOW);
    await pausePlan(db, a.id, NOW + 2 * HOUR);
    await pausePlan(db, c.id, null);
    await setPlanQuietUntil(db, a.id, NOW + HOUR);
    await setPlanSkippedDate(db, a.id, '2026-09-28');

    expect(await refreshPlanStatuses(db, NOW + HOUR / 2)).toEqual([]);

    // Three days later in Lagos: b (28–30 Sep) is over, a's pause and markers have expired.
    const later = Date.parse('2026-10-01T09:00:00Z');
    expect((await refreshPlanStatuses(db, later)).sort()).toEqual([a.id, b.id].sort());
    expect(await getPlan(db, a.id)).toMatchObject({ status: 'active', quietUntil: null, skippedDate: null });
    expect((await getPlan(db, b.id))!.status).toBe('ended');
    expect((await getPlan(db, c.id))!.status).toBe('paused');
  });

  it('ends a plan by its own time zone, not the device', async () => {
    const r = fixture('01-clean-v1.md');
    const p = await createPlan(db, { ...r.plan, tz: 'Pacific/Auckland', days: 1 }, r.notifs, NOW);
    // 2026-09-28T12:30Z is already 29 Sep in Auckland (UTC+13) but still 28 Sep in Lagos.
    expect(await refreshPlanStatuses(db, Date.parse('2026-09-28T12:30:00Z'))).toEqual([p.id]);
  });

  it('Run again copies a finished plan with a new start', async () => {
    const plan = await startClean();
    await updatePlan(db, plan.id, { weekendStart: '09:30' });
    await setPlanOnMiss(db, plan.id, 'nudge_once');
    const copy = await duplicatePlan(db, plan.id, '2026-11-01', NOW + HOUR);
    expect(copy).toMatchObject({ title: plan.title, start: '2026-11-01', days: 30, status: 'active', weekendStart: '09:30' });
    expect(copy.id).not.toBe(plan.id);
    const notifs = await listNotifs(db, copy.id);
    expect(notifs).toHaveLength(7);
    expect(notifs.every((n) => n.onMiss === 'nudge_once')).toBe(true);
  });

  it('planDay counts calendar days in the plan tz', () => {
    const p = { start: '2026-09-17', tz: 'Africa/Lagos' };
    expect(planDay(p, NOW)).toBe(12);
    expect(planDay({ ...p, start: '2026-09-29' }, NOW)).toBeNull();
  });

  it('deleting a plan removes its notifs and occurrences', async () => {
    const plan = await startClean();
    const [n] = await listNotifs(db, plan.id);
    await upsertOccurrence(db, { notifId: n!.id, fireAt: NOW, localDate: '2026-09-28', messageIndex: 0 });
    await deletePlan(db, plan.id);
    const counts = await db.getFirstAsync<{ n: number; o: number }>(
      'SELECT (SELECT COUNT(*) FROM notif) AS n, (SELECT COUNT(*) FROM occurrence) AS o',
    );
    expect(counts).toEqual({ n: 0, o: 0 });
  });
});

describe('notifs', () => {
  it('Edit notif validates the merged result', async () => {
    const plan = await startClean();
    const [breakfast] = await listNotifs(db, plan.id);
    const edited = await updateNotif(db, breakfast!.id, { at: '07:30', on: 'Mon–Fri', priority: 'critical', title: '  Early breakfast ' });
    expect(edited).toMatchObject({ at: '07:30', on: 'weekdays', priority: 'critical', title: 'Early breakfast' });

    await expect(updateNotif(db, breakfast!.id, { at: null })).rejects.toThrow(/needs a time/);
    await expect(updateNotif(db, breakfast!.id, { messages: ['  '] })).rejects.toThrow(/at least one message/);
    await expect(updateNotif(db, breakfast!.id, { on: 'fortnightly' })).rejects.toThrow(/repeat rule/);
    await expect(updateNotif(db, breakfast!.id, { icon: 'rocket' as never })).rejects.toThrow(/icon/);
    expect((await updateNotif(db, breakfast!.id, { at: null, enabled: false })).enabled).toBe(false);
  });

  it('addNotif appends with a unique key', async () => {
    const plan = await startClean();
    const n = await addNotif(db, plan.id, {
      id: 'breakfast',
      title: 'Second breakfast',
      icon: 'bowl',
      at: '10:30',
      on: 'sat',
      priority: 'silent',
      optional: true,
      onMiss: 'none',
      enabled: true,
      messages: ['Elevenses.'],
    });
    expect(n).toMatchObject({ key: 'breakfast-2', sort: 7, planId: plan.id });
  });
});

describe('occurrences', () => {
  async function seed() {
    const plan = await startClean();
    const [breakfast, hydration] = await listNotifs(db, plan.id);
    const b = await upsertOccurrence(db, { notifId: breakfast!.id, fireAt: NOW, localDate: '2026-09-28', messageIndex: 4 });
    const h = await upsertOccurrence(db, { notifId: hydration!.id, fireAt: NOW + 3 * HOUR, localDate: '2026-09-28', messageIndex: 0 });
    const tomorrow = await upsertOccurrence(db, {
      notifId: breakfast!.id,
      fireAt: NOW + 24 * HOUR,
      localDate: '2026-09-29',
      messageIndex: 5,
    });
    return { plan, breakfast: breakfast!, b, h, tomorrow };
  }

  it('upsert is idempotent and keeps the state the user set', async () => {
    const { breakfast, b } = await seed();
    await setOccurrenceState(db, b.id, 'done', NOW + 12 * 60_000);
    const again = await upsertOccurrence(db, { notifId: breakfast.id, fireAt: NOW, localDate: '2026-09-28', messageIndex: 4 });
    expect(again).toMatchObject({ id: b.id, state: 'done', actedAt: NOW + 12 * 60_000 });
    const count = await db.getFirstAsync<{ c: number }>('SELECT COUNT(*) AS c FROM occurrence');
    expect(count?.c).toBe(3);
  });

  it('views carry the plan, title and the rotated message', async () => {
    const { b } = await seed();
    const view = (await getOccurrence(db, b.id))!;
    // Breakfast has 3 messages; index 4 → 4 % 3 = 1.
    expect(view).toMatchObject({
      planTitle: '30-Day PCOS Wellness',
      title: 'Breakfast',
      icon: 'sun',
      message: 'Eggs, beans or yoghurt — pick one before 9.',
    });
  });

  it('lists a day and a window in time order', async () => {
    await seed();
    expect((await listOccurrencesOn(db, '2026-09-28')).map((o) => o.title)).toEqual(['Breakfast', 'Hydration check']);
    expect((await listOccurrencesBetween(db, NOW + 1, NOW + 48 * HOUR)).map((o) => o.localDate)).toEqual([
      '2026-09-28',
      '2026-09-29',
    ]);
  });

  it('marks unanswered past occurrences missed and clears future pending ones', async () => {
    const { b, h, tomorrow } = await seed();
    await setOccurrenceState(db, h.id, 'snoozed', NOW + 3 * HOUR);
    expect(await markMissed(db, NOW + 4 * HOUR)).toBe(1);
    expect((await getOccurrence(db, b.id))!.state).toBe('missed');
    expect((await getOccurrence(db, h.id))!.state).toBe('snoozed');

    expect(await deletePendingFrom(db, NOW + HOUR)).toBe(1);
    expect(await getOccurrence(db, tomorrow.id)).toBeNull();
    await expect(setOccurrenceState(db, tomorrow.id, 'done')).rejects.toThrow(/No occurrence/);
  });

  it('planHistory tallies per notif and per day', async () => {
    const { plan, b, h, tomorrow } = await seed();
    await setOccurrenceState(db, b.id, 'done');
    await setOccurrenceState(db, h.id, 'skipped');
    await setOccurrenceState(db, tomorrow.id, 'snoozed');
    const hist = await planHistory(db, plan.id, '2026-09-22', '2026-09-28');
    expect(hist.total).toEqual({ done: 1, snoozed: 0, skipped: 1, missed: 0 });
    expect(hist.byDay).toEqual([{ date: '2026-09-28', done: 1, snoozed: 0, skipped: 1, missed: 0 }]);
    expect(hist.byNotif.map((n) => [n.title, n.done, n.skipped])).toEqual([
      ['Breakfast', 1, 0],
      ['Hydration check', 0, 1],
    ]);
  });
});

describe('settings', () => {
  it('returns defaults, then stored values', async () => {
    expect(await getSettings(db)).toEqual({
      onboarded: false,
      name: null,
      pause: null,
      quiet: null,
      dailyCap: null,
      criticalBreaksQuiet: true,
    });
    const s = await updateSettings(db, {
      onboarded: true,
      name: ' Ife ',
      dailyCap: 10,
      quiet: { start: '22:30', end: '06:30' },
      pause: { until: null },
    });
    expect(s).toMatchObject({ onboarded: true, name: 'Ife', dailyCap: 10, pause: { until: null } });
    expect(await getSettings(db)).toEqual(s);
    await expect(updateSettings(db, { dailyCap: 0 })).rejects.toThrow(/dailyCap/);
  });

  it('isPausedAll respects the end time', () => {
    const base = { onboarded: true, name: null, quiet: null, dailyCap: null, criticalBreaksQuiet: true };
    expect(isPausedAll({ ...base, pause: null }, NOW)).toBe(false);
    expect(isPausedAll({ ...base, pause: { until: null } }, NOW)).toBe(true);
    expect(isPausedAll({ ...base, pause: { until: NOW + HOUR } }, NOW)).toBe(true);
    expect(isPausedAll({ ...base, pause: { until: NOW - 1 } }, NOW)).toBe(false);
  });
});
