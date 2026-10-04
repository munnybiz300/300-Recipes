// Bridges to phone features. Inside the APK these use Capacitor's native
// plugins; in a desktop browser they fall back to web equivalents.

const Cap = () => window.Capacitor;
export const isNative = () => !!(Cap() && Cap().isNativePlatform && Cap().isNativePlatform());
const plugin = (name) => (isNative() && Cap().Plugins ? Cap().Plugins[name] : null);

import { t } from './i18n.js';

const UA_MOBILE = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36';
const UA_DESKTOP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const pageHeaders = (ua) => ({
  'User-Agent': ua,
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9,es-MX;q=0.8,es;q=0.7',
  'Cache-Control': 'no-cache',
  'Upgrade-Insecure-Requests': '1',
});

export class SiteError extends Error {
  constructor(status) { super(t('siteError', status)); this.status = status; }
}

// Native requests are not limited by browser cross-site rules, which is what
// makes importing from any recipe website possible.
export async function fetchText(url) {
  const http = plugin('CapacitorHttp');
  if (http) {
    // Some sites turn away anything that doesn't look like a normal browser,
    // so try as a phone browser first, then as a desktop browser.
    let res;
    for (const ua of [UA_MOBILE, UA_DESKTOP]) {
      res = await http.get({ url, headers: pageHeaders(ua), responseType: 'text' });
      if (res.status < 400) return typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
      if (![403, 401, 429, 503].includes(res.status)) break;
    }
    throw new SiteError(res.status);
  }
  const res = await fetch(url);
  if (!res.ok) throw new SiteError(res.status);
  return res.text();
}

export async function fetchImageDataUrl(url) {
  const http = plugin('CapacitorHttp');
  if (http) {
    const res = await http.get({ url, headers: { 'User-Agent': UA_MOBILE }, responseType: 'blob' });
    if (res.status >= 400) throw new Error('image ' + res.status);
    const type = (res.headers && (res.headers['Content-Type'] || res.headers['content-type'])) || 'image/jpeg';
    return `data:${type.split(';')[0]};base64,${res.data}`;
  }
  const res = await fetch(url);
  const blob = await res.blob();
  return new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(blob); });
}

// Save a backup file. On the phone this opens the share sheet so you can
// send it to Google Drive, email, Files, Nearby Share, etc.
export async function saveFile(filename, text, mime = 'application/json') {
  const fs = plugin('Filesystem'), share = plugin('Share');
  if (fs && share) {
    const { uri } = await fs.writeFile({ path: filename, data: text, directory: 'CACHE', encoding: 'utf8' });
    await share.share({ title: filename, files: [uri], url: uri, dialogTitle: t('saveBackupTitle') });
    return;
  }
  const blob = new Blob([text], { type: mime });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

// ---------- notifications for timers ----------
let notifPermission = null;
async function notifications() {
  const ln = plugin('LocalNotifications');
  if (!ln) return null;
  if (notifPermission == null) {
    try {
      let p = await ln.checkPermissions();
      if (p.display !== 'granted') p = await ln.requestPermissions();
      notifPermission = p.display === 'granted';
    } catch { notifPermission = false; }
  }
  return notifPermission ? ln : null;
}
const notifId = (timerId) => Math.abs([...timerId].reduce((a, c) => (a * 31 + c.charCodeAt(0)) | 0, 7)) % 2000000000;

export async function scheduleTimerNotification(timer) {
  const ln = await notifications();
  if (!ln) return;
  try {
    await ln.schedule({ notifications: [{
      id: notifId(timer.id), title: t('timerNotifTitle'), body: timer.label,
      schedule: { at: new Date(timer.endAt), allowWhileIdle: true },
    }] });
  } catch { /* the in-app alarm still works */ }
}
export async function cancelTimerNotification(timer) {
  const ln = plugin('LocalNotifications');
  if (!ln) return;
  try { await ln.cancel({ notifications: [{ id: notifId(timer.id) }] }); } catch { /* ignore */ }
}

// ---------- keep screen on (cook mode) ----------
let wakeLock = null;
let wantAwake = false;
export async function keepAwake(on) {
  wantAwake = on;
  const ka = plugin('KeepAwake');
  if (ka) {
    try { await (on ? ka.keepAwake() : ka.allowSleep()); return on; } catch { /* fall through */ }
  }
  try {
    if (on && 'wakeLock' in navigator) {
      wakeLock = await navigator.wakeLock.request('screen');
      return true;
    }
    if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
  } catch { return false; }
  return false;
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && wantAwake) keepAwake(true);
});

export function vibrate(pattern) {
  try { navigator.vibrate && navigator.vibrate(pattern); } catch { /* ignore */ }
}

// ---------- Timer alarm: the town tune ----------
// 16 equal slots of 0.3125 s = exactly 5 s per play, then it loops.
//   letter = note for one slot    x = rest    - = hold the previous note one more slot
//   ? = a random note of the C major scale, picked fresh on every play
// The last "x" is the pause before the next play. Same sound as the old
// 3-note chime (soft sine "pluck"), in the C5–B5 octave.
export const TUNE = 'E G C E D B G F E x ? x C - - x'.split(' ');
export const SLOT = 0.3125;
export const TUNE_SECONDS = TUNE.length * SLOT; // 5
const SCALE = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
const SEMITONES = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const C5 = 523.2511306011972;
export const noteFreq = (n) => C5 * Math.pow(2, SEMITONES[n] / 12);

// Turns the tune into notes: [{ note, freq, start, dur }] (times in seconds from the start)
export function buildTune(rand = Math.random) {
  const out = [];
  TUNE.forEach((tok, slot) => {
    if (tok === 'x') return;
    if (tok === '-') { if (out.length) out[out.length - 1].dur += SLOT; return; }
    const note = tok === '?' ? SCALE[Math.floor(rand() * SCALE.length)] : tok;
    out.push({ note, freq: noteFreq(note), start: slot * SLOT, dur: SLOT });
  });
  return out;
}

// Schedules one play of the tune on an audio context, starting at `at` (audio-clock seconds).
export function scheduleTune(ctx, dest, at, rand = Math.random, oscs) {
  const notes = buildTune(rand);
  for (const n of notes) {
    const t0 = at + n.start;
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'sine'; o.frequency.value = n.freq;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(0.35, t0 + 0.02);        // same quick attack as before
    if (n.dur > SLOT + 1e-6) {                                    // held note: gentle sustain, then fade
      g.gain.exponentialRampToValueAtTime(0.14, t0 + n.dur * 0.6);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + n.dur - 0.02);
    } else {
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.18);     // same pluck as before
    }
    o.connect(g).connect(dest);
    o.start(t0); o.stop(t0 + Math.max(0.2, n.dur));
    if (oscs) { oscs.add(o); o.onended = () => oscs.delete(o); }
  }
  return notes;
}

let audioCtx, alarm = null;

// Call about once a second while a timer is ringing. Schedules each play ahead of time
// on the audio clock, so the 5-second loop never drifts or stutters.
// Returns true when a new play of the tune has just been scheduled to start.
export function alarmTick() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const now = audioCtx.currentTime;
    if (!alarm) {
      const master = audioCtx.createGain();
      master.connect(audioCtx.destination);
      alarm = { master, oscs: new Set(), next: now + 0.05 };
    }
    if (alarm.next < now - 0.5) alarm.next = now + 0.05; // woke up late: restart cleanly
    let started = false;
    while (alarm.next < now + 1.5) {
      scheduleTune(audioCtx, alarm.master, alarm.next, Math.random, alarm.oscs);
      alarm.next += TUNE_SECONDS;
      started = true;
    }
    return started;
  } catch { return false; /* no audio */ }
}

// Silences the alarm right away, including notes already queued.
export function stopAlarm() {
  if (!alarm) return;
  const a = alarm; alarm = null;
  try {
    const now = audioCtx.currentTime;
    a.master.gain.cancelScheduledValues(now);
    a.master.gain.setValueAtTime(0, now);
    a.oscs.forEach((o) => { try { o.stop(now); } catch { /* already stopped */ } });
    setTimeout(() => { try { a.master.disconnect(); } catch { /* ignore */ } }, 200);
  } catch { /* ignore */ }
}

// ---------- Android back button ----------
export function onBackButton(handler) {
  const app = plugin('App');
  if (!app) return false;
  app.addListener('backButton', handler);
  return true;
}
export async function leaveApp() {
  const app = plugin('App');
  if (!app) return;
  // Send the app to the background (like the home button) so running
  // timers and the current screen are kept; fall back to closing it.
  try { await app.minimizeApp(); } catch { try { await app.exitApp(); } catch { /* ignore */ } }
}
