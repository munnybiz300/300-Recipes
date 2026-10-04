// Bridges to phone features. Inside the APK these use Capacitor's native
// plugins; in a desktop browser they fall back to web equivalents.

const Cap = () => window.Capacitor;
export const isNative = () => !!(Cap() && Cap().isNativePlatform && Cap().isNativePlatform());
const plugin = (name) => (isNative() && Cap().Plugins ? Cap().Plugins[name] : null);

const UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Mobile Safari/537.36';

// Native requests are not limited by browser cross-site rules, which is what
// makes importing from any recipe website possible.
export async function fetchText(url) {
  const http = plugin('CapacitorHttp');
  if (http) {
    const res = await http.get({ url, headers: { 'User-Agent': UA, Accept: 'text/html,*/*' }, responseType: 'text' });
    if (res.status >= 400) throw new Error(`The site answered with error ${res.status}.`);
    return typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`The site answered with error ${res.status}.`);
  return res.text();
}

export async function fetchImageDataUrl(url) {
  const http = plugin('CapacitorHttp');
  if (http) {
    const res = await http.get({ url, headers: { 'User-Agent': UA }, responseType: 'blob' });
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
    await share.share({ title: filename, files: [uri], url: uri, dialogTitle: 'Save your backup' });
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
      id: notifId(timer.id), title: '⏰ Timer done', body: timer.label,
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

let audioCtx;
export function beep() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const now = audioCtx.currentTime;
    [0, 0.22, 0.44].forEach((t, i) => {
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.type = 'sine'; o.frequency.value = i === 2 ? 1175 : 880;
      g.gain.setValueAtTime(0.0001, now + t);
      g.gain.exponentialRampToValueAtTime(0.35, now + t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, now + t + 0.18);
      o.connect(g).connect(audioCtx.destination);
      o.start(now + t); o.stop(now + t + 0.2);
    });
  } catch { /* no audio */ }
}
