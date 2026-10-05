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
// ===================== ALARM SETTINGS: tweak the timing here =====================
export const ALARM = {
  slotSeconds: 0.3125,     // length of one slot. 16 slots = one play (0.3125 x 16 = 5 s)
  extraPauseSeconds: 0,    // extra silence after slot 16, before the tune repeats (0 = none)
  maxRingSeconds: 60,      // keeps looping this long unless you tap Dismiss
  volume: 0.95,            // loudness of each note, 0 to 1 (1 = the most the phone allows)
  brightness: 0,           // 0 = pure tone (as requested). If it's ever too quiet over a mixer, try 0.3:
                           // adds a soft layer an octave up that phone speakers play louder; same notes.
};
// ================================================================================

// The tune, one entry per slot (scientific pitch: middle C = C4).
//   'x' = rest   '-' = hold the previous note (no new attack)   '?' = random note (see RANDOM_POOL)
export const TUNE = [
  'E4', //  1  low E
  'G4', //  2
  'C5', //  3
  'E5', //  4  high E
  'D5', //  5
  'B4', //  6
  'G4', //  7
  'F4', //  8
  'E4', //  9  low E
  'x',  // 10  rest
  '?',  // 11  random note
  'x',  // 12  rest
  'C5', // 13  C starts
  '-',  // 14  hold C
  '-',  // 15  hold C
  'x',  // 16  rest = the gap before the next play
];
// "?" picks one of these, fresh on every play: the C major notes from low E to high E
export const RANDOM_POOL = ['E4', 'F4', 'G4', 'A4', 'B4', 'C5', 'D5', 'E5'];

export const playSeconds = (cfg = ALARM) => TUNE.length * cfg.slotSeconds + cfg.extraPauseSeconds;
export const TUNE_SECONDS = playSeconds(); // 5 with the settings above

const SEMITONES = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
export function noteFreq(name) { // 'E4' -> 329.63 Hz, exact equal temperament (A4 = 440 Hz)
  const oct = Number(name.slice(1));
  return 261.6255653005986 * Math.pow(2, (SEMITONES[name[0]] + 12 * (oct - 4)) / 12);
}

// Turns the tune into notes: [{ note, freq, start, dur }] (seconds from the start of a play)
export function buildTune(rand = Math.random, cfg = ALARM) {
  const out = [];
  TUNE.forEach((tok, slot) => {
    if (tok === 'x') return;
    if (tok === '-') { if (out.length) out[out.length - 1].dur += cfg.slotSeconds; return; }
    const note = tok === '?' ? RANDOM_POOL[Math.floor(rand() * RANDOM_POOL.length)] : tok;
    out.push({ note, freq: noteFreq(note), start: slot * cfg.slotSeconds, dur: cfg.slotSeconds });
  });
  return out;
}

// The sound: the same pure sine tone as before, but each note now rings for its whole slot
// instead of a short ping, which is what makes it much louder without changing the pitch.
// (The Android player in native/android/TuneSynth.java uses this exact same shape.)
export const ENVELOPE = {
  attack: 0.012,   // seconds to reach full strength
  release: 0.03,   // seconds to fade out at the end of the note (avoids clicks)
  ring: 1.14,      // gentle fade while ringing: about 30% quieter by the end of one slot
};

// Schedules one play of the tune on a Web Audio context, starting at `at` (audio-clock seconds).
export function scheduleTune(ctx, dest, at, rand = Math.random, oscs, cfg = ALARM) {
  const notes = buildTune(rand, cfg);
  const peak = Math.max(0.0002, Math.min(1, cfg.volume));
  for (const n of notes) {
    const t0 = at + n.start, rel = Math.min(ENVELOPE.release, n.dur * 0.3);
    const g = ctx.createGain();
    const bright = Math.max(0, cfg.brightness || 0);
    const layers = bright ? [[n.freq, 1 / (1 + bright)], [n.freq * 2, bright / (1 + bright)]] : [[n.freq, 1]];
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(peak, t0 + ENVELOPE.attack);
    g.gain.exponentialRampToValueAtTime(peak * Math.exp(-ENVELOPE.ring * (n.dur - rel)), t0 + n.dur - rel);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + n.dur);
    g.connect(dest);
    for (const [freq, level] of layers) {
      const o = ctx.createOscillator(), lv = ctx.createGain();
      o.type = 'sine'; o.frequency.value = freq; lv.gain.value = level;
      o.connect(lv).connect(g);
      o.start(t0); o.stop(t0 + n.dur + 0.005);
      if (oscs) { oscs.add(o); o.onended = () => oscs.delete(o); }
    }
  }
  return notes;
}

// Two ways to play it:
//  1. Inside the APK: a tiny native plugin plays it on Android's ALARM volume (not media volume).
//  2. Anywhere else (or if the plugin isn't there): Web Audio, which follows media volume.
let audioCtx, alarm = null, nativeBroken = false;

// Call about once a second while a timer is ringing.
// Returns true when a new play of the tune is starting (used for the vibration).
export function alarmTick() {
  const nat = nativeBroken ? null : plugin('Alarm');
  return nat ? nativeTick(nat) : webTick();
}

function nativeTick(nat) {
  const now = Date.now();
  if (!alarm) {
    const len = playSeconds();
    alarm = { native: true, len, nextPlay: now + len * 1000 };
    // Each play gets its own random "?" note; the plugin just plays what it is given
    const count = Math.max(1, Math.ceil(ALARM.maxRingSeconds / len));
    const plays = Array.from({ length: count }, () => buildTune().map((n) => ({ f: n.freq, s: n.start, d: n.dur })));
    Promise.resolve(nat.play({ plays, playSeconds: len, peak: ALARM.volume, brightness: ALARM.brightness || 0, attack: ENVELOPE.attack, release: ENVELOPE.release, ring: ENVELOPE.ring }))
      .catch(() => { nativeBroken = true; alarm = null; }); // fall back to Web Audio
    return true;
  }
  if (alarm.native && now >= alarm.nextPlay) { alarm.nextPlay += alarm.len * 1000; return true; }
  return false;
}

// Web Audio: each play is scheduled ahead on the audio clock, so the 5-second loop never drifts.
function webTick() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const now = audioCtx.currentTime;
    if (!alarm || alarm.native) {
      const master = audioCtx.createGain();
      master.connect(audioCtx.destination);
      alarm = { master, oscs: new Set(), next: now + 0.05 };
    }
    if (alarm.next < now - 0.5) alarm.next = now + 0.05; // woke up late: restart cleanly
    let started = false;
    while (alarm.next < now + 1.5) {
      scheduleTune(audioCtx, alarm.master, alarm.next, Math.random, alarm.oscs);
      alarm.next += playSeconds();
      started = true;
    }
    return started;
  } catch { return false; /* no audio */ }
}

// Silences the alarm right away, including notes already queued.
export function stopAlarm() {
  if (!alarm) return;
  const a = alarm; alarm = null;
  if (a.native) {
    try { const nat = plugin('Alarm'); if (nat) Promise.resolve(nat.stop()).catch(() => {}); } catch { /* ignore */ }
    return;
  }
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
