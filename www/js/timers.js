// Step timers. They keep their end time, so they stay correct even if the
// app is closed or the phone is locked; a notification fires when one ends.

import { h, icon, confirmDialog, toast } from './ui.js';
import { t as tr } from './i18n.js';
import { formatClock } from './parser.js';
import { scheduleTimerNotification, cancelTimerNotification, vibrate, beep } from './native.js';

let timers = load();
let ringTick = null;
const refs = new Map(); // timer id -> { clock, prog }

function load() {
  try { return JSON.parse(localStorage.getItem('timers') || '[]'); } catch { return []; }
}
function save() {
  try { localStorage.setItem('timers', JSON.stringify(timers)); } catch { /* ignore */ }
}

export function startTimer({ label, seconds, key }) {
  const existing = timers.find((t) => t.key === key && t.state !== 'done');
  if (existing) { toast(tr('timerRunning')); return; }
  const t = { id: 'tm' + Date.now().toString(36), key, label, total: seconds, endAt: Date.now() + seconds * 1000, state: 'running' };
  timers.push(t);
  save();
  scheduleTimerNotification(t);
  render();
}

function remaining(t) {
  if (t.state === 'paused') return t.left;
  return Math.max(0, (t.endAt - Date.now()) / 1000);
}

function pause(t) {
  t.left = remaining(t); t.state = 'paused';
  cancelTimerNotification(t); save(); render();
}
function resume(t) {
  t.endAt = Date.now() + t.left * 1000; t.state = 'running';
  scheduleTimerNotification(t); save(); render();
}
function remove(t) {
  timers = timers.filter((x) => x !== t);
  cancelTimerNotification(t); save(); render();
}

async function skip(t) {
  const ok = await confirmDialog({
    title: tr('skipTimerQ'),
    message: tr('skipTimerBody', t.label),
    ok: tr('skipTimer'),
    cancel: tr('keepIt'),
    danger: true,
  });
  if (ok) remove(t);
}

export function render() {
  const box = document.getElementById('timers');
  if (!box) return;
  box.innerHTML = '';
  refs.clear();
  for (const t of timers) {
    const left = remaining(t);
    if (t.state === 'running' && left <= 0) { t.state = 'ringing'; t.rangAt = Date.now(); save(); }
    const ringing = t.state === 'ringing';
    const pct = ringing ? 100 : 100 * (1 - left / t.total);
    const clock = h('div', { class: 'clock' }, ringing ? tr('timerDone') : formatClock(left));
    const prog = h('div', { class: 'prog', style: { width: pct + '%' } });
    refs.set(t.id, { clock, prog });
    const el = h('div', { class: 'timer' + (t.state === 'paused' ? ' paused' : '') + (ringing ? ' ringing' : '') },
      h('div', { class: 'tl' },
        clock,
        h('small', {}, t.label)),
      ringing
        ? h('button', { onclick: () => remove(t) }, icon('check', 'sm'), tr('dismiss'))
        : [
          h('button', { 'aria-label': t.state === 'paused' ? tr('resume') : tr('pause'), onclick: () => (t.state === 'paused' ? resume(t) : pause(t)) },
            icon(t.state === 'paused' ? 'play' : 'pause', 'sm')),
          h('button', { onclick: () => skip(t) }, icon('skip', 'sm'), tr('skip')),
        ],
      prog,
    );
    box.append(el);
  }
  document.body.classList.toggle('has-timers', timers.length > 0);
}

function tick() {
  let anyRinging = false;
  let changed = false;
  for (const t of timers) {
    if (t.state === 'running' && remaining(t) <= 0) { t.state = 'ringing'; t.rangAt = Date.now(); changed = true; }
    if (t.state === 'ringing') anyRinging = true;
  }
  if (changed) { save(); render(); }
  for (const t of timers) {
    const r = refs.get(t.id);
    if (!r || t.state !== 'running') continue;
    const left = remaining(t);
    r.clock.textContent = formatClock(left);
    r.prog.style.width = 100 * (1 - left / t.total) + '%';
  }
  if (anyRinging) {
    // Chime every 2 seconds for up to a minute
    const now = Date.now();
    const recent = timers.some((t) => t.state === 'ringing' && now - (t.rangAt || now) < 60000);
    if (recent && (!ringTick || now - ringTick > 2000)) { ringTick = now; beep(); vibrate([300, 150, 300]); }
  }
}

export function initTimers() {
  render();
  setInterval(tick, 1000);
}
