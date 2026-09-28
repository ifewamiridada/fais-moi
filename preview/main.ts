/**
 * Browser test bench for fais-moi: the real parser, database and scheduler, a simulated
 * clock, and a pretend lock screen standing in for the OS. Built by preview/build.mjs.
 */
import messyReply from '../src/parser/__fixtures__/10-text-parsefail.md';
import { blockingIssues, buildFixItPrompt, describeOn, describeSource, formatQuiet, formatTime, parsePlan } from '../src/parser';
import { addDays, endDate, formatDate, todayIn } from '../src/parser/dates';
import type { NotifDraft, ParseResult } from '../src/parser/types';
import {
  createPlan,
  deletePlan,
  listNotifs,
  listOccurrencesOn,
  listPlans,
  migrate,
  pausePlan,
  planDay,
  resumePlan,
  setPlanSkippedDate,
  type Db,
} from '../src/db';
import { ACTION, handleAction, MAX_SCHEDULED, OS_LIMIT, reconcile, type Notifier, type OsNotification } from '../src/scheduler';
import { wallClock, zonedTime } from '../src/scheduler/tz';
import { openBrowserDb } from './sqljsDb';

const MIN = 60_000;
const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

// ---- state -------------------------------------------------------------------------

let db: Db;
let now = Math.floor(Date.now() / MIN) * MIN;
let permission = true;
let scheduled: OsNotification[] = [];
let delivered: Array<{ n: OsNotification; firedAt: number }> = [];
let review: { result: ParseResult; notifs: NotifDraft[] } | null = null;

const notifier: Notifier = {
  canNotify: async () => permission,
  cancelAll: async () => {
    scheduled = [];
  },
  schedule: async (n) => {
    scheduled.push(n);
    return `preview-${n.id}`;
  },
};

// ---- helpers -----------------------------------------------------------------------

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: unknown) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const hm = (t: number) => wallClock(t, tz).hm;
const today = () => todayIn(tz, now);

function when(t: number): string {
  const d = wallClock(t, tz).date;
  const time = formatTime(hm(t));
  if (d === today()) return time;
  if (d === addDays(today(), 1)) return `Tomorrow ${time}`;
  return `${formatDate(d)} ${time}`;
}

function ago(t: number): string {
  const m = Math.round((now - t) / MIN);
  if (m < 1) return 'now';
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}

let toastTimer = 0;
function toast(msg: string) {
  const el = $('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (el.hidden = true), 2600);
}

// ---- samples -----------------------------------------------------------------------

function quickSample(): string {
  const at = (m: number) => hm(now + m * MIN);
  return JSON.stringify(
    {
      format: 'fais-moi/1',
      plan: 'Quick test',
      start: today(),
      days: 2,
      tz,
      limits: { per_day: 10, quiet: '03:00-03:01' },
      notifs: [
        { id: 'water', title: 'Glass of water', icon: 'drop', at: at(2), messages: ['Try Done on this one.', 'Second day, second glass.'] },
        { id: 'stretch', title: 'Stretch', icon: 'move', at: at(4), on_miss: 'nudge_once', messages: ['Leave this one: a nudge follows 30 minutes later.'] },
        { id: 'call', title: 'Call Mum', icon: 'talk', at: at(6), messages: ['Try In 30 min on this one.'] },
        { id: 'meds', title: 'Evening meds', icon: 'spark', at: at(8), priority: 'critical', messages: ["Can't miss: breaks through Focus on iPhone."] },
      ],
    },
    null,
    2,
  );
}

function wellnessSample(): string {
  return JSON.stringify(
    {
      format: 'fais-moi/1',
      plan: '30-Day PCOS Wellness',
      start: today(),
      days: 30,
      tz,
      limits: { per_day: 6, quiet: '22:30-06:30' },
      notifs: [
        { id: 'breakfast', title: 'Breakfast', icon: 'sun', at: '08:00', messages: ['Start with a protein-rich breakfast.', 'Eggs, beans or yoghurt — pick one before 9.', 'Add some fibre: oats or fruit.'] },
        { id: 'hydration', title: 'Hydration check', icon: 'drop', at: '11:00', on: 'weekdays', optional: true, messages: ['Glass of water before your next task.', 'Refill your bottle.'] },
        { id: 'lunch', title: 'Lunch check', icon: 'bowl', at: '13:00', messages: ['Protein + fibre + something colourful.', 'Half the plate vegetables today.'] },
        { id: 'move', title: 'Movement', icon: 'move', at: '18:00', messages: ['20-minute walk — no phone.', 'Take the stairs twice today.'] },
        { id: 'reset', title: 'Mental reset', icon: 'moon', at: '20:30', on_miss: 'nudge_once', messages: ['What can you release today?', 'Three slow breaths before bed.'] },
        { id: 'faith', title: 'Faith grounding', icon: 'book', at: '21:00', priority: 'critical', messages: ['You can be diligent without carrying everything.', 'Be still, and know.'] },
        { id: 'meal-prep', title: 'Meal prep day', icon: 'bowl', at: '10:00', on: 'sat', messages: ['Prep lunches for the week.'] },
      ],
    },
    null,
    2,
  );
}

function capSample(): string {
  const daily = ['Breakfast 08:00', 'Hydration 11:00', 'Lunch check 13:00', 'Movement 18:00', 'Mental reset 20:30', 'Faith grounding 21:00'];
  return JSON.stringify(
    {
      format: 'fais-moi/1',
      plan: 'Too many on Saturday',
      start: today(),
      days: 14,
      tz,
      limits: { per_day: 6, quiet: '22:30-06:30' },
      notifs: [
        ...daily.map((d, i) => {
          const [title, at] = [d.slice(0, d.lastIndexOf(' ')), d.slice(d.lastIndexOf(' ') + 1)];
          return { id: `n${i}`, title, at, optional: title === 'Hydration', messages: [`${title} time.`] };
        }),
        { id: 'meal-prep', title: 'Meal prep day', at: '10:00', on: 'sat', messages: ['Prep lunches for the week.'] },
      ],
    },
    null,
    2,
  );
}

const SAMPLES: Record<string, () => string> = {
  quick: quickSample,
  wellness: wellnessSample,
  messy: () => messyReply,
  cap: capSample,
};

// ---- core --------------------------------------------------------------------------

async function replan() {
  await reconcile(db, notifier, { now, deviceTz: tz });
  await render();
}

/** Moves the clock; everything the phone had scheduled up to then fires on the lock screen. */
async function advanceTo(t: number) {
  const due = scheduled.filter((n) => n.fireAt <= t).sort((a, b) => a.fireAt - b.fireAt);
  for (const n of due) delivered.push({ n, firedAt: n.fireAt });
  now = t;
  await replan();
  if (due.length) toast(due.length === 1 ? `1 notif arrived` : `${due.length} notifs arrived`);
}

function readPlan(text: string) {
  const result = parsePlan(text, { today: today(), deviceTz: tz });
  // "Use the N we found": notifs that can't be scheduled start switched off.
  const notifs = result.notifs.map((n) => ({ ...n, enabled: n.enabled && !!n.at && n.messages.length > 0 }));
  review = { result, notifs };
}

async function startPlan() {
  if (!review) return;
  try {
    const plan = await createPlan(db, review.result.plan, review.notifs, now);
    review = null;
    toast(`Started ${plan.title}`);
    await replan();
  } catch (e) {
    toast((e as Error).message);
  }
}

// ---- render ------------------------------------------------------------------------

async function render() {
  renderLock();
  renderReview();
  await Promise.all([renderToday(), renderOs(), renderPlans()]);
  $('off-banner').hidden = permission;
  $('jump-next').toggleAttribute('disabled', !scheduled.length);
}

function renderLock() {
  const w = wallClock(now, tz);
  const [h, m] = w.hm.split(':').map(Number);
  $('lock-clock').textContent = `${h! % 12 || 12}:${String(m).padStart(2, '0')}`;
  $('lock-date').textContent = new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: tz })
    .format(now)
    .replace(',', '');

  const stack = $('stack');
  if (!delivered.length) {
    stack.innerHTML = `<p class="lock-empty">No notifications yet. Use Next notif to move the clock to the next one.</p>`;
    return;
  }
  stack.innerHTML = delivered
    .map(({ n, firedAt }, i) => {
      const newest = i === delivered.length - 1;
      const tag = n.data.kind === 'nudge' ? 'Nudge' : n.data.kind === 'snooze' ? 'Snoozed' : n.priority === 'critical' ? 'Time Sensitive' : '';
      const actions = n.withActions
        ? `<div class="note-actions">
            <button class="primary" data-act="${ACTION.done}" data-i="${i}">Done</button>
            <button data-act="${ACTION.snooze}" data-i="${i}">In 30 min</button>
            <button data-act="${ACTION.skip}" data-i="${i}">Skip today</button>
          </div>`
        : '';
      return `<article class="note${newest ? '' : ' older'}">
        <div class="note-row">
          <div class="app-tile" aria-hidden="true">f.</div>
          <div class="note-text">
            <div class="note-meta"><b>${esc(n.subtitle ?? 'fais-moi')}</b><span>${ago(firedAt)}</span></div>
            <span class="note-title">${esc(n.title)}</span>
            <span class="note-body">${esc(n.body)}</span>
            ${tag ? `<span class="note-tag">${tag}</span>` : ''}
          </div>
        </div>
        ${actions}
      </article>`;
    })
    .join('');
}

function issueTag(i: ParseResult['issues'][number]) {
  if (i.fixed) return '<span class="pill ok">Fixed</span>';
  if (i.severity === 'info') return '<span class="pill neutral">Note</span>';
  return '<span class="pill look">Needs a look</span>';
}

function renderReview() {
  const panel = $('review');
  if (!review) {
    panel.hidden = true;
    $('format').innerHTML = '';
    return;
  }
  const { result, notifs } = review;
  panel.hidden = false;
  $('format').innerHTML = `<span class="pill format">${esc(describeSource(result.source))}</span>`;

  if (result.status === 'failed') {
    panel.innerHTML = `<div class="panel-head"><h2 id="review-h">Couldn't read that</h2></div>
      <p class="sub">${esc(result.issues[0]?.message ?? '')}</p>
      <div class="fixit" id="fixit-text">${esc(buildFixItPrompt(result))}</div>
      <div class="row-actions"><button class="btn secondary" id="copy-fixit">Copy fix-it prompt</button></div>`;
    return;
  }

  const p = result.plan;
  const last = endDate(p.start, p.days);
  const dates = last ? `${formatDate(p.start)} → ${formatDate(last)}` : `From ${formatDate(p.start)}, ongoing`;
  const usable = notifs.filter((n) => n.enabled).length;
  const blocked = blockingIssues({ issues: result.issues, notifs }).length > 0;
  const partial = result.status === 'partial';
  const label = partial ? `Use the ${usable} we found` : 'Start plan';

  panel.innerHTML = `
    <div class="panel-head">
      <h2 id="review-h">${partial ? "We couldn't read all of that." : "Here's what we understood."}</h2>
      <span class="pill ${partial ? 'look' : 'ok'}">${partial ? 'Partly read' : 'Ready'}</span>
    </div>
    <p class="sub"><b>${esc(p.title)}</b> · ${dates} · Up to ${p.perDay} a day · Quiet ${esc(formatQuiet(p.quiet))}</p>
    ${
      result.issues.length
        ? `<ul class="issues">${result.issues.map((i) => `<li>${issueTag(i)}<span>${esc(i.message)}</span></li>`).join('')}</ul>`
        : ''
    }
    <ul class="list">${notifs
      .map((n, i) => {
        const extra = [
          `${n.messages.length} message${n.messages.length === 1 ? '' : 's'}`,
          n.priority === 'critical' ? "Can't miss" : n.priority === 'silent' ? 'Silent' : '',
          n.optional ? 'Optional' : '',
          n.onMiss === 'nudge_once' ? 'Nudge once' : '',
        ].filter(Boolean);
        const canOn = !!n.at && n.messages.length > 0;
        return `<li class="${n.enabled ? '' : 'faded'}">
          <span class="time">${n.at ? formatTime(n.at) : 'No time'}</span>
          <span class="what"><b>${esc(n.title)}</b><span>${esc(describeOn(n.on))} · ${esc(extra.join(' · '))}</span></span>
          <input type="checkbox" aria-label="Turn ${esc(n.title)} on" data-toggle="${i}" ${n.enabled ? 'checked' : ''} ${canOn ? '' : 'disabled'}>
        </li>`;
      })
      .join('')}</ul>
    ${
      partial
        ? `<div class="fixit" id="fixit-text">${esc(buildFixItPrompt(result))}</div>
           <div class="row-actions"><button class="btn secondary" id="copy-fixit">Copy fix-it prompt</button></div>`
        : ''
    }
    <div class="row-actions"><button class="btn" id="start" ${blocked || !usable ? 'disabled' : ''}>${esc(label)}</button></div>`;
}

const STATE_LABEL = { done: 'Done', snoozed: 'Snoozed', skipped: 'Skipped', missed: 'Missed' } as const;

async function renderToday() {
  const rows = await listOccurrencesOn(db, today());
  const left = rows.filter((o) => o.state === 'pending' && o.fireAt > now).length;
  $('today-sub').textContent = `${new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: tz }).format(now)} · ${left} notif${left === 1 ? '' : 's'} left`;
  $('today').innerHTML = rows.length
    ? rows
        .map((o) => {
          const pill =
            o.state === 'pending'
              ? o.fireAt > now
                ? '<span class="pill pending">Coming up</span>'
                : '<span class="pill look">Waiting</span>'
              : `<span class="pill ${o.state}">${STATE_LABEL[o.state]}</span>`;
          const faded = o.state === 'done' || o.state === 'skipped';
          return `<li class="${faded ? 'faded' : ''}">
            <span class="time">${formatTime(hm(o.fireAt))}</span>
            <span class="what"><b>${esc(o.title)}</b><span>${esc(o.message)} · ${esc(o.planTitle)}</span></span>
            ${pill}
          </li>`;
        })
        .join('')
    : '<li><span class="empty" style="grid-column: 1 / -1">Nothing today. Start a plan, or move the clock.</span></li>';
}

async function renderOs() {
  const n = scheduled.length;
  $('os-sub').textContent = permission ? `${n} of ${OS_LIMIT} slots · at most ${MAX_SCHEDULED} notifs + 1 reminder to open the app` : 'Nothing: notifications are off';
  $<HTMLSpanElement>('os-meter').style.width = `${(n / OS_LIMIT) * 100}%`;
  const shown = scheduled.slice(0, 8);
  $('os').innerHTML = n
    ? shown
        .map((s) => {
          const kind =
            s.data.kind === 'keepalive' ? 'Open-the-app reminder' : s.data.kind === 'nudge' ? 'Nudge' : s.data.kind === 'snooze' ? 'Snooze' : '';
          return `<li>
            <span class="time">${esc(when(s.fireAt))}</span>
            <span class="what"><b>${esc(s.title)}</b><span>${esc(s.body)}</span></span>
            ${kind ? `<span class="pill kind">${kind}</span>` : `<span class="pill neutral">${esc(s.priority === 'critical' ? "Can't miss" : s.priority === 'silent' ? 'Silent' : 'Gentle')}</span>`}
          </li>`;
        })
        .join('') + (n > shown.length ? `<li><span class="empty" style="grid-column: 1 / -1">and ${n - shown.length} more, up to ${when(scheduled[n - 1]!.fireAt)}</span></li>` : '')
    : `<li><span class="empty" style="grid-column: 1 / -1">${permission ? 'Nothing scheduled yet.' : 'Turn notifications back on to refill it.'}</span></li>`;
}

async function renderPlans() {
  const plans = await listPlans(db);
  if (!plans.length) {
    $('plans').innerHTML = '<p class="empty">No plans yet. Paste one above.</p>';
    return;
  }
  const rows = await Promise.all(
    plans.map(async (p) => {
      const count = (await listNotifs(db, p.id)).filter((n) => n.enabled).length;
      const day = planDay(p, now);
      const dayText = p.status === 'ended' ? 'Finished' : day === null ? `Starts ${formatDate(p.start)}` : p.days ? `Day ${day} of ${p.days}` : 'Every day';
      const skipped = p.skippedDate === todayIn(p.tz, now);
      const status =
        p.status === 'paused' ? '<span class="pill snoozed">Paused</span>' : p.status === 'ended' ? '<span class="pill neutral">Ended</span>' : '<span class="pill ok">Running</span>';
      return `<div class="plan-row">
        <div class="top"><span class="title">${esc(p.title)}</span>${status}</div>
        <div class="top"><span class="day">${esc(dayText)}</span><span class="sub">${count} notifs · Up to ${p.perDay} a day</span></div>
        <div class="row-actions">
          ${p.status === 'paused' ? `<button class="small-btn" data-plan="resume" data-id="${p.id}">Resume</button>` : p.status === 'active' ? `<button class="small-btn" data-plan="pause" data-id="${p.id}">Pause</button>` : ''}
          ${p.status === 'active' ? `<button class="small-btn" data-plan="skip" data-id="${p.id}">${skipped ? 'Undo skip today' : 'Skip today'}</button>` : ''}
          <button class="small-btn" data-plan="delete" data-id="${p.id}">Delete</button>
        </div>
      </div>`;
    }),
  );
  $('plans').innerHTML = rows.join('');
}

// ---- events ------------------------------------------------------------------------

function wire() {
  $('clock-buttons').addEventListener('click', async (e) => {
    const jump = (e.target as HTMLElement).closest<HTMLElement>('[data-jump]')?.dataset.jump;
    if (!jump) return;
    if (jump === 'next') {
      const next = scheduled[0];
      if (!next) return toast('Nothing scheduled');
      await advanceTo(next.fireAt);
    } else if (jump === '10m') await advanceTo(now + 10 * MIN);
    else if (jump === '1h') await advanceTo(now + 60 * MIN);
    else await advanceTo(zonedTime(addDays(today(), 1), '07:00', tz));
  });

  $('stack').addEventListener('click', async (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
    if (!btn) return;
    const item = delivered[Number(btn.dataset.i)];
    if (!item) return;
    const outcome = await handleAction(db, btn.dataset.act!, item.n.data, now);
    const occ = item.n.data.occurrenceId;
    delivered = delivered.filter((d) => d !== item && !(outcome !== 'ignored' && d.n.data.occurrenceId === occ));
    toast({ done: 'Done', snoozed: 'Back in 30 minutes', skipped: 'Skipped for today', opened: 'Opened', ignored: 'Already answered' }[outcome]);
    await replan();
  });

  $<HTMLInputElement>('perm').addEventListener('change', async (e) => {
    permission = (e.target as HTMLInputElement).checked;
    await replan();
    toast(permission ? 'Notifications on: schedule refilled' : 'Notifications off: schedule cleared');
  });

  $('samples').addEventListener('click', (e) => {
    const key = (e.target as HTMLElement).closest<HTMLElement>('[data-sample]')?.dataset.sample;
    if (!key) return;
    $<HTMLTextAreaElement>('plan-input').value = SAMPLES[key]!();
    readPlan($<HTMLTextAreaElement>('plan-input').value);
    renderReview();
  });

  $('read').addEventListener('click', () => {
    readPlan($<HTMLTextAreaElement>('plan-input').value);
    renderReview();
    $('review').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });

  $('review').addEventListener('click', async (e) => {
    const t = e.target as HTMLElement;
    if (t.id === 'start') await startPlan();
    if (t.id === 'copy-fixit') {
      const text = $('fixit-text').textContent ?? '';
      try {
        await navigator.clipboard.writeText(text);
        toast('Fix-it prompt copied');
      } catch {
        const range = document.createRange();
        range.selectNodeContents($('fixit-text'));
        getSelection()?.removeAllRanges();
        getSelection()?.addRange(range);
        toast('Selected: copy it from here');
      }
    }
  });

  $('review').addEventListener('change', (e) => {
    const t = e.target as HTMLInputElement;
    if (!review || t.dataset.toggle === undefined) return;
    const i = Number(t.dataset.toggle);
    review.notifs[i] = { ...review.notifs[i]!, enabled: t.checked };
    renderReview();
  });

  $('plans').addEventListener('click', async (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-plan]');
    if (!btn) return;
    const id = Number(btn.dataset.id);
    const plan = (await listPlans(db)).find((p) => p.id === id);
    if (!plan) return;
    const action = btn.dataset.plan;
    if (action === 'pause') await pausePlan(db, id, null);
    if (action === 'resume') await resumePlan(db, id);
    if (action === 'skip') await setPlanSkippedDate(db, id, plan.skippedDate === todayIn(plan.tz, now) ? null : todayIn(plan.tz, now));
    if (action === 'delete') {
      await deletePlan(db, id);
      delivered = delivered.filter((d) => d.n.subtitle !== plan.title);
    }
    await replan();
  });

  $('reset').addEventListener('click', async () => {
    db = await freshDb();
    delivered = [];
    review = null;
    now = Math.floor(Date.now() / MIN) * MIN;
    await replan();
    toast('Started over');
  });
}

async function freshDb(): Promise<Db> {
  const d = await openBrowserDb();
  await migrate(d);
  return d;
}

// ---- boot: open in a working state -------------------------------------------------

(async () => {
  db = await freshDb();
  wire();
  // A running 30-day plan, so Today and the phone's schedule have something in them…
  readPlan(wellnessSample());
  await startPlan();
  // …and a quick test waiting on the Review panel.
  $<HTMLTextAreaElement>('plan-input').value = quickSample();
  readPlan(quickSample());
  await replan();
})();
