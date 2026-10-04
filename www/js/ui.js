// Small UI helpers: element builder, icons, dialogs, toasts, image handling.
import { t, locale } from './i18n.js';

// Safety net: never print the words "null"/"undefined"/"false" on screen when
// an optional piece of a screen is left out.
for (const proto of [Element.prototype, DocumentFragment.prototype]) {
  for (const m of ['append', 'prepend']) {
    const orig = proto[m];
    proto[m] = function (...nodes) { return orig.apply(this, nodes.filter((n) => n != null && n !== false)); };
  }
}

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'html') el.innerHTML = v;
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  append(el, children);
  return el;
}
function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

const PATHS = {
  back: '<path d="M15 5l-7 7 7 7"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>',
  settings: '<path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16v4z"/><path d="M13.5 6.5l4 4"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="3"/><circle cx="9" cy="10" r="2"/><path d="M21 16l-5-5-8 9"/>',
  camera: '<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>',
  link: '<path d="M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 00-5.7 0l-3 3a4 4 0 005.7 5.7l1-1"/>',
  clipboard: '<rect x="6" y="4" width="12" height="17" rx="2"/><path d="M9 4h6v3H9z"/><path d="M9 12h6M9 16h4"/>',
  pen: '<path d="M12 20h8"/><path d="M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z"/>',
  flame: '<path d="M12 3c1 4 5 5.5 5 10a5 5 0 01-10 0c0-2.5 1.5-3.5 2-5 1 1 1.5 2 1.5 3 1.5-1.5 1.5-5 1.5-8z"/>',
  timer: '<circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 2.5M9 2h6"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  download: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
  upload: '<path d="M12 20V9M7 14l5-5 5 5M5 4h14"/>',
  play: '<path d="M8 5l11 7-11 7z"/>',
  pause: '<path d="M8 5v14M16 5v14"/>',
  skip: '<path d="M6 5l9 7-9 7zM18 5v14"/>',
  list: '<path d="M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  tag: '<path d="M3 12V4h8l10 10-8 8z"/><circle cx="7.5" cy="8.5" r="1.5"/>',
  note: '<path d="M5 4h14v12l-4 4H5z"/><path d="M15 20v-4h4M8 9h8M8 13h5"/>',
  reset: '<path d="M4 12a8 8 0 108-8 8 8 0 00-6.3 3"/><path d="M4 4v4h4"/>',
  scale: '<path d="M12 3v18M5 7h14M7 7l-3 7a3 3 0 006 0zM17 7l-3 7a3 3 0 006 0z"/>',
  chevron: '<path d="M6 9l6 6 6-6"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 010 18M12 3a14 14 0 000 18"/>',
  more: '<circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/>',
  heart: '<path d="M12 21l-1.4-1.3C5.4 15 2 11.9 2 8.1 2 5 4.4 2.5 7.5 2.5c1.7 0 3.4.8 4.5 2.1 1.1-1.3 2.8-2.1 4.5-2.1C19.6 2.5 22 5 22 8.1c0 3.8-3.4 6.9-8.6 11.6z"/>',
  pot: '<path d="M4 11h16v2.5A6.5 6.5 0 0113.5 20h-3A6.5 6.5 0 014 13.5z"/><path d="M2 11h20M9 7.5c0-1.2 1-1.6 1-3M14 7.5c0-1.2 1-1.6 1-3"/>',
  collections: '<rect x="3.5" y="3.5" width="7" height="7" rx="2"/><rect x="13.5" y="3.5" width="7" height="7" rx="2"/><rect x="3.5" y="13.5" width="7" height="7" rx="2"/><rect x="13.5" y="13.5" width="7" height="7" rx="2"/>',
  copy: '<rect x="8.5" y="8.5" width="11.5" height="11.5" rx="2.5"/><path d="M15.5 8.5V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7.5a2 2 0 002 2h2.5"/>',
  star: '<path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z"/>',
};

export function icon(name, cls = '') {
  const span = document.createElement('span');
  span.innerHTML = `<svg class="icon ${cls}" viewBox="0 0 24 24" aria-hidden="true">${PATHS[name] || ''}</svg>`;
  return span.firstChild;
}

// ---------- overlays ----------
// Every popup, sheet and full-screen mode (cook mode) is an "overlay".
// Each one adds a step to the back history. Pressing back (or closing it)
// removes exactly one step, so only the top overlay closes — closing a
// popup inside cook mode no longer closes cook mode too.

const stack = []; // [{ depth, teardown }]
const depthNow = () => (history.state && history.state.ovDepth) || 0;

window.addEventListener('popstate', () => {
  const d = depthNow();
  while (stack.length && stack[stack.length - 1].depth > d) stack.pop().teardown();
});

export function pushOverlay(teardown) {
  const depth = (stack.length ? stack[stack.length - 1].depth : depthNow()) + 1;
  history.pushState({ ovDepth: depth }, '');
  const o = { depth, teardown };
  stack.push(o);
  return {
    close() {
      if (!stack.includes(o)) return;
      history.back(); // the popstate above runs teardown
      // Safety net in case the browser never reports the back step
      setTimeout(() => {
        const i = stack.indexOf(o);
        if (i !== -1) stack.splice(i).reverse().forEach((x) => x.teardown());
      }, 700);
    },
  };
}
export const hasOverlay = () => stack.length > 0;

export function openSheet(build, { center = false } = {}) {
  return new Promise((resolve) => {
    const scrim = h('div', { class: 'scrim' + (center ? ' center' : '') });
    const box = h('div', { class: center ? 'dialog' : 'sheet' });
    if (!center) box.append(h('div', { class: 'grab' }));
    let result;
    const onKey = (e) => { if (e.key === 'Escape') close(undefined); };
    const ov = pushOverlay(() => {
      scrim.remove();
      document.removeEventListener('keydown', onKey);
      resolve(result);
    });
    const close = (val) => { result = val; scrim.style.display = 'none'; ov.close(); };
    scrim.addEventListener('click', (e) => { if (e.target === scrim) close(undefined); });
    document.addEventListener('keydown', onKey);
    build(box, close);
    scrim.append(box);
    document.body.append(scrim);
    const first = box.querySelector('input,textarea');
    if (first) setTimeout(() => first.focus(), 60);
  });
}

export function confirmDialog({ title, message = '', ok = t('ok'), cancel = t('cancel'), danger = false }) {
  return openSheet((box, close) => {
    box.append(h('h3', {}, title));
    if (message) box.append(h('p', {}, message));
    box.append(
      h('div', { class: 'actions' },
        h('button', { class: 'btn sm', onclick: () => close(false) }, cancel),
        h('button', { class: 'btn sm ' + (danger ? 'danger' : 'primary'), onclick: () => close(true) }, ok)),
    );
  }, { center: true }).then((v) => !!v);
}

export function promptDialog({ title, message = '', value = '', placeholder = '', ok = t('save'), multiline = false, inputmode }) {
  return openSheet((box, close) => {
    const input = multiline
      ? h('textarea', { rows: 4, placeholder })
      : h('input', { type: 'text', placeholder, inputmode });
    input.value = value;
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !multiline) close(input.value); });
    box.append(h('h3', {}, title));
    if (message) box.append(h('p', {}, message));
    box.append(
      h('div', { class: 'field' }, input),
      h('div', { class: 'actions' },
        h('button', { class: 'btn sm', onclick: () => close(undefined) }, t('cancel')),
        h('button', { class: 'btn sm primary', onclick: () => close(input.value) }, ok)),
    );
  }, { center: true });
}

let toastTimer;
export function toast(msg) {
  document.querySelectorAll('.toast').forEach((t) => t.remove());
  const t = h('div', { class: 'toast' }, msg);
  document.body.append(t);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.remove(), 2600);
}

// ---------- images ----------

export function pickFiles({ accept = 'image/*', multiple = true } = {}) {
  return new Promise((resolve) => {
    const input = h('input', { type: 'file', accept, multiple, style: { display: 'none' } });
    input.addEventListener('change', () => { resolve([...input.files]); input.remove(); });
    document.body.append(input);
    input.click();
  });
}

function loadImage(src) {
  return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });
}

export async function resizeImage(srcOrFile, max = 1600, quality = 0.84) {
  const src = typeof srcOrFile === 'string' ? srcOrFile : URL.createObjectURL(srcOrFile);
  try {
    const img = await loadImage(src);
    const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.round(img.naturalWidth * scale), hgt = Math.round(img.naturalHeight * scale);
    const c = document.createElement('canvas');
    c.width = w; c.height = hgt;
    c.getContext('2d').drawImage(img, 0, 0, w, hgt);
    return c.toDataURL('image/jpeg', quality);
  } finally {
    if (typeof srcOrFile !== 'string') URL.revokeObjectURL(src);
  }
}

export function fmtDate(ts) {
  return new Date(ts).toLocaleDateString(locale(), { month: 'short', day: 'numeric', year: 'numeric' });
}
