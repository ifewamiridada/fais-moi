/**
 * Scheduler check — a temporary screen for build step 3, to test reconcile() and the
 * notification actions on a real device. Replaced by Welcome / Today in step 4.
 */
import * as Notifications from 'expo-notifications';
import { useCallback, useEffect, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { createPlan, deletePlan, listOccurrencesOn, listPlans, type OccurrenceView } from '../src/db';
import { todayIn } from '../src/parser/dates';
import { parsePlan } from '../src/parser';
import { permissionStatus, requestPermission } from '../src/notify/expo';
import { getDb, runReconcile } from '../src/platform/runtime';
import { wallClock } from '../src/scheduler/tz';

const C = {
  night: '#2B0A0E',
  wine: '#5A0E18',
  signal: '#B0121F',
  blushSoft: '#FBE3E7',
  paper: '#FCF3F1',
  muted: '#7D4B52',
  border: '#F1D3D8',
};
const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
const hm = (t: number) => wallClock(t, tz).hm;

/** A plan whose notifs fire in the next few minutes, to try the buttons. */
function quickTestPlan() {
  const now = Date.now();
  const at = (min: number) => hm(now + min * 60_000);
  return JSON.stringify({
    format: 'fais-moi/1',
    plan: 'Scheduler test',
    start: todayIn(tz),
    days: 2,
    tz,
    limits: { per_day: 10, quiet: '03:00-03:01' },
    notifs: [
      { id: 'gentle', title: 'Gentle one', at: at(2), messages: ['Try Done on this one.'] },
      { id: 'nudge', title: 'Nudge me', at: at(3), on_miss: 'nudge_once', messages: ['Ignore me: a nudge comes in 30 min.'] },
      { id: 'snooze', title: 'Snooze me', at: at(4), messages: ['Try In 30 min.'] },
      { id: 'critical', title: "Can't miss", at: at(5), priority: 'critical', messages: ['Time Sensitive — shows through Focus.'] },
      { id: 'silent', title: 'Silent one', at: at(6), priority: 'silent', messages: ['No sound for this one.'] },
    ],
  });
}

const SAMPLE = () =>
  JSON.stringify({
    format: 'fais-moi/1',
    plan: '30-Day PCOS Wellness',
    start: todayIn(tz),
    days: 30,
    tz,
    limits: { per_day: 6, quiet: '22:30-06:30' },
    notifs: [
      { id: 'breakfast', title: 'Breakfast', icon: 'sun', at: '08:00', messages: ['Start with a protein-rich breakfast.', 'Eggs, beans or yoghurt — pick one.'] },
      { id: 'hydration', title: 'Hydration check', icon: 'drop', at: '11:00', on: 'weekdays', optional: true, messages: ['Glass of water before your next task.'] },
      { id: 'lunch', title: 'Lunch check', icon: 'bowl', at: '13:00', messages: ['Half the plate vegetables today.'] },
      { id: 'move', title: 'Movement', icon: 'move', at: '18:00', messages: ['20-minute walk — no phone.'] },
      { id: 'reset', title: 'Mental reset', icon: 'moon', at: '20:30', on_miss: 'nudge_once', messages: ['What can you release today?'] },
      { id: 'faith', title: 'Faith grounding', icon: 'book', at: '21:00', priority: 'critical', messages: ['Be still, and know.'] },
    ],
  });

export default function SchedulerCheck() {
  const [permission, setPermission] = useState('…');
  const [os, setOs] = useState<Notifications.NotificationRequest[]>([]);
  const [today, setToday] = useState<OccurrenceView[]>([]);
  const [plans, setPlans] = useState<Array<{ id: number; label: string }>>([]);
  const [log, setLog] = useState('');
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const db = await getDb();
    setPermission(await permissionStatus());
    const scheduled = await Notifications.getAllScheduledNotificationsAsync();
    const time = (r: Notifications.NotificationRequest) => {
      const t = r.trigger as { value?: number; date?: number } | null;
      return t?.value ?? t?.date ?? 0;
    };
    setOs(scheduled.sort((a, b) => time(a) - time(b)));
    setToday(await listOccurrencesOn(db, todayIn(tz)));
    setPlans((await listPlans(db)).map((p) => ({ id: p.id, label: `${p.title} · ${p.status}` })));
  }, []);

  useEffect(() => {
    void refresh();
    const sub = Notifications.addNotificationResponseReceivedListener(() => setTimeout(refresh, 500));
    return () => sub.remove();
  }, [refresh]);

  const run = (label: string, fn: () => Promise<string | void>) => async () => {
    setBusy(true);
    try {
      const msg = await fn();
      setLog(`${label}: ${msg ?? 'ok'}`);
    } catch (e) {
      setLog(`${label} failed: ${(e as Error).message}`);
    } finally {
      setBusy(false);
      await refresh();
    }
  };

  const importPlan = (json: string) => async () => {
    const r = parsePlan(json);
    if (r.status !== 'ok') return `parser said ${r.status}: ${r.issues.map((i) => i.message).join(' ')}`;
    await createPlan(await getDb(), r.plan, r.notifs);
    const res = await runReconcile();
    return `${res.status}, ${res.scheduled.length} scheduled`;
  };

  return (
    <SafeAreaView style={s.screen}>
      <ScrollView contentContainerStyle={s.body} refreshControl={<RefreshControl refreshing={busy} onRefresh={refresh} />}>
        <Text style={s.wordmark}>fais-moi.</Text>
        <Text style={s.h1}>Scheduler check</Text>
        <Text style={s.muted}>Temporary screen for build step 3. Time zone: {tz}</Text>

        <View style={s.card}>
          <Text style={s.label}>Notifications: {permission}</Text>
          {permission !== 'granted' && <Button title="Turn on notifications" onPress={run('Permission', async () => String(await requestPermission()))} />}
          <Button title="Add quick test plan (fires in 2–6 min)" onPress={run('Quick test', importPlan(quickTestPlan()))} />
          <Button title="Add 30-day sample plan" onPress={run('Sample', importPlan(SAMPLE()))} />
          <Button title="Reconcile now" onPress={run('Reconcile', async () => {
            const r = await runReconcile();
            return `${r.status}, ${r.scheduled.length} scheduled`;
          })} />
          <Button title="Delete all plans" tone="quiet" onPress={run('Delete', async () => {
            const db = await getDb();
            for (const p of await listPlans(db)) await deletePlan(db, p.id);
            await runReconcile();
          })} />
          {!!log && <Text style={s.log}>{log}</Text>}
        </View>

        <Text style={s.h2}>Plans</Text>
        {plans.length ? plans.map((p) => <Text key={p.id} style={s.row}>{p.label}</Text>) : <Text style={s.muted}>None yet.</Text>}

        <Text style={s.h2}>Today</Text>
        {today.length ? (
          today.map((o) => (
            <Text key={o.id} style={[s.row, o.state !== 'pending' && s.faded]}>
              {hm(o.fireAt)}  {o.title} — {o.state}
            </Text>
          ))
        ) : (
          <Text style={s.muted}>Nothing today.</Text>
        )}

        <Text style={s.h2}>Scheduled with the OS · {os.length}/64</Text>
        {os.map((r) => {
          const t = r.trigger as { value?: number; date?: number } | null;
          const when = t?.value ?? t?.date;
          return (
            <Text key={r.identifier} style={s.row}>
              {when ? new Date(when).toLocaleString() : '—'}  {r.content.title} · {r.identifier}
            </Text>
          );
        })}
      </ScrollView>
    </SafeAreaView>
  );
}

function Button({ title, onPress, tone = 'primary' }: { title: string; onPress: () => void; tone?: 'primary' | 'quiet' }) {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [s.button, tone === 'quiet' && s.quiet, pressed && { opacity: 0.8 }]}>
      <Text style={[s.buttonText, tone === 'quiet' && { color: C.wine }]}>{title}</Text>
    </Pressable>
  );
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: C.paper },
  body: { padding: 20, gap: 8, paddingBottom: 60 },
  wordmark: { fontSize: 22, fontWeight: '900', color: C.signal },
  h1: { fontSize: 28, fontWeight: '700', color: C.night, marginTop: 8 },
  h2: { fontSize: 17, fontWeight: '700', color: C.night, marginTop: 20 },
  muted: { color: C.muted },
  card: { backgroundColor: '#fff', borderRadius: 28, padding: 18, gap: 10, marginTop: 12, borderWidth: 1, borderColor: C.border },
  label: { color: C.night, fontWeight: '600' },
  button: { minHeight: 44, borderRadius: 999, backgroundColor: C.signal, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 18 },
  quiet: { backgroundColor: C.blushSoft },
  buttonText: { color: '#fff', fontWeight: '600' },
  log: { color: C.muted, fontSize: 13 },
  row: { color: C.night, fontSize: 14 },
  faded: { opacity: 0.45 },
});
