import * as db from './db.js';
import {
  h, icon, openSheet, confirmDialog, promptDialog, toast, pickFiles, resizeImage, fmtDate,
  pushOverlay, hasOverlay,
} from './ui.js';
import {
  scaleIngredient, parseIngredient, formatQty, isSection, sectionName, findDurations,
  formatDurationLabel, extractRecipeFromHtml, parsePastedRecipe, factorFromUsed, setParserLang,
} from './parser.js';
import { fetchText, fetchImageDataUrl, saveFile, keepAwake, onBackButton, leaveApp, SiteError } from './native.js';
import { initTimers, startTimer, render as renderTimers } from './timers.js';
import { t, getLang, setLang, locale } from './i18n.js';

const app = document.getElementById('app');

// ---------- app state ----------
let recipes = [];
const SORTS = ['new', 'old', 'az', 'za'];
const homeState = { query: '', tags: [], fav: false, sort: SORTS.includes(localStorage.getItem('sort')) ? localStorage.getItem('sort') : 'new' };
const scaleState = new Map(); // recipeId -> { factor, note }
const tabState = new Map();   // recipeId -> tab name
let pendingDraft = null;      // imported recipe waiting in the editor
let backGuard = null;         // set by the editor: asks before leaving with unsaved changes

setParserLang(getLang());

async function refresh() { recipes = await db.allRecipes(); }

function allTags() {
  const counts = new Map();
  for (const r of recipes) for (const tg of r.tags || []) {
    const k = tg.toLowerCase();
    const cur = counts.get(k) || { name: tg, count: 0 };
    cur.count++; counts.set(k, cur);
  }
  return [...counts.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, locale()));
}

function go(hash) { if (location.hash !== hash) location.hash = hash; else route(); }

// ---------- router ----------
async function route() {
  backGuard = null;
  const hash = location.hash || '#/';
  window.scrollTo(0, 0);
  const [, page, id] = hash.split('/');
  if (!page) return renderHome();
  if (page === 'r' && id) return renderDetail(id);
  if (page === 'edit') return renderEditor(id);
  if (page === 'new') return renderEditor(null);
  if (page === 'settings') return renderSettings();
  renderHome();
}

function screen(...children) {
  app.innerHTML = '';
  const s = h('div', { class: 'screen' }, ...children);
  app.append(s);
  return s;
}

// ---------- Android back button ----------
// Closes the top popup first, then goes to the previous screen.
// Only on the home screen does it leave the app.
async function handleBack() {
  if (hasOverlay()) { history.back(); return; }
  const hash = location.hash || '#/';
  if (hash === '#/' || hash === '#') { leaveApp(); return; }
  if (backGuard && !(await backGuard())) return;
  history.back();
}

// =====================================================================
// HOME
// =====================================================================

function matches(r, q, tagFilter) {
  const tags = (r.tags || []).map((x) => x.toLowerCase());
  for (const tg of tagFilter) if (!tags.includes(tg.toLowerCase())) return false;
  const tokens = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!tokens.length) return true;
  const title = (r.title || '').toLowerCase();
  const ings = (r.ingredients || []).join(' ').toLowerCase();
  return tokens.every((tok) => {
    if (tok.startsWith('#')) { const x = tok.slice(1); return tags.some((y) => y.includes(x)); }
    return title.includes(tok) || tags.some((x) => x.includes(tok)) || ings.includes(tok);
  });
}

function sortList(list) {
  const byTitle = (a, b) => (a.title || '').localeCompare(b.title || '', locale(), { sensitivity: 'base' });
  if (homeState.sort === 'az') return list.sort(byTitle);
  if (homeState.sort === 'za') return list.sort((a, b) => byTitle(b, a));
  if (homeState.sort === 'old') return list.sort((a, b) => a.created - b.created);
  return list.sort((a, b) => b.created - a.created);
}

function renderHome() {
  const s = screen();
  const head = h('header', { class: 'home-head' },
    h('div', {}, h('h1', {}, t('recipes')), h('div', { class: 'count' }, t('recipeCount', recipes.length))),
    h('button', { class: 'icon-btn', 'aria-label': t('settings'), onclick: () => go('#/settings') }, icon('settings')));

  const input = h('input', { type: 'search', placeholder: t('searchPlaceholder'), value: homeState.query, enterkeyhint: 'search' });
  const clearBtn = h('button', { class: 'icon-btn', style: { width: '32px', height: '32px' }, 'aria-label': t('clear'), onclick: () => { input.value = ''; homeState.query = ''; update(); input.focus(); } }, icon('x', 'sm'));
  const search = h('div', { class: 'search-wrap' }, h('label', { class: 'search' }, icon('search'), input, clearBtn));
  const chips = h('div', { class: 'chips' });
  const sortRow = h('div', { class: 'sort-row' });
  const grid = h('div', { class: 'grid' });
  const empty = h('div');

  input.addEventListener('input', () => { homeState.query = input.value; update(); });

  function update() {
    clearBtn.classList.toggle('hidden', !homeState.query);
    chips.innerHTML = '';
    // Favorites always comes first
    if (recipes.length) {
      chips.append(h('button', {
        class: 'chip fav-chip' + (homeState.fav ? ' on' : ''),
        onclick: () => { homeState.fav = !homeState.fav; update(); },
      }, icon('heart', 'sm'), t('favorites')));
    }
    // then selected tags, then tags matching the search text, then the rest
    const q = homeState.query.trim().toLowerCase().replace(/^#/, '');
    const sel = homeState.tags.map((x) => x.toLowerCase());
    let tags = allTags();
    if (q) tags = [...tags.filter((x) => x.name.toLowerCase().includes(q)), ...tags.filter((x) => !x.name.toLowerCase().includes(q))];
    tags = [...tags.filter((x) => sel.includes(x.name.toLowerCase())), ...tags.filter((x) => !sel.includes(x.name.toLowerCase()))];
    for (const tg of tags) {
      const on = sel.includes(tg.name.toLowerCase());
      chips.append(h('button', {
        class: 'chip' + (on ? ' on' : ''),
        onclick: () => {
          homeState.tags = on ? homeState.tags.filter((x) => x.toLowerCase() !== tg.name.toLowerCase()) : [...homeState.tags, tg.name];
          update(); chips.scrollTo({ left: 0, behavior: 'smooth' });
        },
      }, tg.name, on ? icon('x', 'sm') : null));
    }
    chips.classList.toggle('hidden', !chips.children.length);

    const list = sortList(recipes.filter((r) => (!homeState.fav || r.favorite) && matches(r, homeState.query, homeState.tags)));

    sortRow.innerHTML = '';
    sortRow.append(
      h('span', {}, homeState.query || homeState.tags.length || homeState.fav ? t('matches', list.length) : ''),
      h('button', { class: 'sort-btn', onclick: () => openSortSheet(update) }, t('sort_' + homeState.sort), icon('chevron', 'sm')));
    sortRow.classList.toggle('hidden', !recipes.length);

    grid.innerHTML = '';
    empty.innerHTML = '';
    if (!recipes.length) {
      empty.append(h('div', { class: 'empty' },
        h('h3', {}, t('emptyTitle')),
        h('p', {}, t('emptyBody')),
        h('button', { class: 'btn primary', onclick: openAddSheet }, icon('plus'), t('addFirst'))));
      return;
    }
    if (!list.length) {
      empty.append(h('div', { class: 'empty' }, h('h3', {}, t('nothingFound')),
        h('p', {}, homeState.fav && !homeState.query && !homeState.tags.length ? t('noFavsYet') : t('tryDifferent'))));
      return;
    }
    for (const r of list) grid.append(card(r));
  }

  s.append(head, search, chips, sortRow, grid, empty,
    h('button', { class: 'fab', onclick: openAddSheet }, icon('plus'), t('addRecipe')));
  update();
}

function openSortSheet(update) {
  openSheet((box, close) => {
    box.append(h('h3', { style: { marginBottom: '14px' } }, t('sortBy')));
    for (const k of SORTS) {
      const on = homeState.sort === k;
      box.append(h('button', { class: 'option sort-opt' + (on ? ' on' : ''), onclick: () => close(k) },
        h('b', {}, t('sort_' + k)), on ? icon('check') : null));
    }
  }).then((k) => {
    if (!k) return;
    homeState.sort = k;
    localStorage.setItem('sort', k);
    update();
  });
}

function card(r) {
  const ph = h('div', { class: 'ph' },
    r.thumb ? h('img', { src: r.thumb, alt: '', loading: 'lazy' }) : h('div', { class: 'placeholder' }, (r.title || '?').trim()[0].toUpperCase()));
  const heart = h('button', {
    class: 'card-heart' + (r.favorite ? ' on' : ''), 'aria-label': r.favorite ? t('removeFromFavorites') : t('addToFavorites'),
    onclick: async (e) => {
      e.stopPropagation();
      r.favorite = !r.favorite;
      heart.classList.toggle('on', r.favorite);
      await db.putRecipe(r);
    },
  }, icon('heart'));
  ph.append(heart);
  const tags = (r.tags || []).slice(0, 2).join(' · ');
  return h('div', { class: 'card', role: 'button', tabindex: 0, onclick: () => go('#/r/' + r.id) }, ph, h('h3', {}, r.title), tags ? h('div', { class: 'meta' }, tags) : null);
}

// =====================================================================
// ADD / IMPORT
// =====================================================================

function openAddSheet() {
  openSheet((box, close) => {
    const opt = (ic, title, sub, fn) => h('button', { class: 'option', onclick: () => close(fn) },
      h('div', { class: 'ic' }, icon(ic)), h('div', {}, h('b', {}, title), h('small', {}, sub)));
    box.append(
      h('h3', {}, t('addARecipe')),
      h('p', {}, t('noLimits')),
      opt('link', t('importWeb'), t('importWebSub'), importFromWeb),
      opt('clipboard', t('pasteText'), t('pasteTextSub'), importFromText),
      opt('pen', t('writeMyself'), t('writeMyselfSub'), () => { pendingDraft = null; go('#/new'); }),
    );
  }).then((fn) => fn && fn());
}

async function importOne(url) {
  const html = await fetchText(url);
  const data = extractRecipeFromHtml(html, url);
  if (!data) throw new Error(t('noRecipeOnPage'));
  const draft = {
    title: data.title, ingredients: data.ingredients, steps: data.steps,
    servings: data.servings, yieldText: data.yieldText,
    prepTime: data.prepTime, cookTime: data.cookTime, totalTime: data.totalTime,
    tags: [], suggestedTags: data.suggestedTags, notes: [], newPhotos: [],
  };
  if (data.imageUrl) {
    try { draft.newPhotos.push(await resizeImage(await fetchImageDataUrl(data.imageUrl))); } catch { /* recipe still imports without photo */ }
  }
  return draft;
}

function friendlyError(e) {
  if (e instanceof SiteError) {
    if ([401, 403, 429, 503].includes(e.status)) return t('siteBlocked');
    return t('siteError', e.status);
  }
  const m = String((e && e.message) || e);
  if (/Failed to fetch|NetworkError|network|timed? ?out|UnknownHost|resolve host/i.test(m)) return t('cantReach');
  return m;
}

function importFromWeb() {
  openSheet((box, close) => {
    const ta = h('textarea', { rows: 3, placeholder: 'https://…', autocapitalize: 'off', spellcheck: false });
    const err = h('div', { class: 'error' });
    const btn = h('button', { class: 'btn primary block' }, t('import'));
    const pasteBtn = h('button', { class: 'btn block hidden', style: { marginTop: '10px' }, onclick: () => close('paste') }, icon('clipboard', 'sm'), t('pasteInstead'));
    const status = h('p', { class: 'hidden' });
    btn.addEventListener('click', async () => {
      const urls = (ta.value.match(/https?:\/\/[^\s<>"']+/g) || []);
      err.textContent = '';
      pasteBtn.classList.add('hidden');
      if (!urls.length) { err.textContent = t('pasteLinkHttp'); return; }
      btn.disabled = true;
      btn.innerHTML = ''; btn.append(h('span', { class: 'spinner' }), urls.length > 1 ? t('importing') : t('gettingRecipe'));
      if (urls.length === 1) {
        try {
          pendingDraft = await importOne(urls[0]);
          close('edit');
        } catch (e) {
          err.textContent = friendlyError(e);
          pasteBtn.classList.remove('hidden');
          btn.disabled = false; btn.textContent = t('tryAgain');
        }
        return;
      }
      // Several links: save each one straight away
      let ok = 0; const failed = [];
      status.classList.remove('hidden');
      for (let i = 0; i < urls.length; i++) {
        status.textContent = t('importingNofM', i + 1, urls.length);
        try { await saveDraft(await importOne(urls[i]), null); ok++; } catch { failed.push(urls[i]); }
      }
      await refresh();
      if (failed.length) {
        status.textContent = t('importedSomeFailed', ok);
        ta.value = failed.join('\n');
        btn.disabled = false; btn.textContent = t('retryThese');
        pasteBtn.classList.remove('hidden');
      } else {
        toast(t('importedN', ok));
        close('home');
      }
    });
    box.append(
      h('h3', {}, t('importWeb')),
      h('p', {}, t('importWebBody')),
      h('div', { class: 'field' }, ta), err, status,
      h('div', { style: { height: '14px' } }), btn, pasteBtn);
  }).then((r) => {
    if (r === 'edit') go('#/new');
    else if (r === 'paste') importFromText();
    else if (r === 'home') { if (location.hash.length > 2) go('#/'); else renderHome(); }
  });
}

function importFromText() {
  openSheet((box, close) => {
    const ta = h('textarea', { rows: 10, placeholder: t('pastePlaceholder') });
    box.append(
      h('h3', {}, t('pasteText')),
      h('p', {}, t('pasteTextBody')),
      h('div', { class: 'field' }, ta),
      h('div', { style: { height: '14px' } }),
      h('button', { class: 'btn primary block', onclick: () => close(ta.value) }, t('continue')));
  }).then((text) => {
    if (!text || !text.trim()) return;
    const p = parsePastedRecipe(text);
    pendingDraft = {
      title: p.title === 'Untitled recipe' ? t('untitled') : p.title,
      ingredients: p.ingredients, steps: p.steps, tags: [], newPhotos: [],
      notes: p.notes ? [{ id: db.uid(), date: Date.now(), text: p.notes }] : [],
    };
    go('#/new');
  });
}

// Turn an editor/import draft into a saved recipe
async function saveDraft(d, existing) {
  const r = existing ? { ...existing } : { id: db.uid(), notes: [], photoIds: [] };
  r.title = (d.title || '').trim() || t('untitled');
  r.tags = d.tags || [];
  r.ingredients = d.ingredients || [];
  r.steps = d.steps || [];
  r.servings = d.servings || null;
  r.yieldText = d.yieldText || '';
  r.prepTime = d.prepTime || ''; r.cookTime = d.cookTime || ''; r.totalTime = d.totalTime || '';
  if (!existing && d.notes) r.notes = d.notes;
  // photos
  const ids = [];
  for (const p of d.photos || []) ids.push(p.id);
  for (const data of d.newPhotos || []) {
    const p = await db.putPhoto({ id: db.uid(), recipeId: r.id, data, caption: '', date: Date.now() });
    ids.push(p.id);
  }
  for (const id of d.removedPhotos || []) await db.deletePhoto(id);
  r.photoIds = ids;
  await updateThumb(r);
  await db.putRecipe(r);
  return r;
}

async function updateThumb(r) {
  if (!r.photoIds || !r.photoIds.length) { r.thumb = ''; return; }
  const [cover] = await db.getPhotos([r.photoIds[0]]);
  r.thumb = cover ? await resizeImage(cover.data, 520, 0.8) : '';
}

// =====================================================================
// RECIPE DETAIL
// =====================================================================

function getChecks(id) {
  try { return JSON.parse(localStorage.getItem('checks:' + id)) || { i: [], s: [] }; } catch { return { i: [], s: [] }; }
}
function setChecks(id, c) { localStorage.setItem('checks:' + id, JSON.stringify(c)); }

async function renderDetail(id) {
  const r = await db.getRecipe(id);
  if (!r) return go('#/');
  const photos = await db.getPhotos(r.photoIds || []);
  const s = screen();
  const tab = tabState.get(id) || 'ingredients';

  // hero
  const actions = h('div', { class: 'hero-actions' },
    h('button', { class: 'icon-btn glass', 'aria-label': t('back'), onclick: () => (history.length > 1 ? history.back() : go('#/')) }, icon('back')),
    h('div', { class: 'right' },
      h('button', {
        class: 'icon-btn glass heart-btn' + (r.favorite ? ' on' : ''), 'aria-label': t('favorite'),
        onclick: async (e) => {
          r.favorite = !r.favorite;
          e.currentTarget.classList.toggle('on', r.favorite);
          await db.putRecipe(r); await refresh();
          toast(r.favorite ? t('addedToFavorites') : t('removedFromFavorites'));
        },
      }, icon('heart')),
      h('button', { class: 'icon-btn glass', 'aria-label': t('edit'), onclick: () => go('#/edit/' + id) }, icon('edit'))));
  let hero;
  if (photos.length) {
    const track = h('div', { class: 'hero-track' }, photos.map((p) => h('img', { src: p.data, alt: '' })));
    const dots = photos.length > 1 ? h('div', { class: 'dots' }, photos.map((_, i) => h('span', { class: i === 0 ? 'on' : '' }))) : null;
    if (dots) track.addEventListener('scroll', () => {
      const i = Math.round(track.scrollLeft / track.clientWidth);
      [...dots.children].forEach((d, j) => d.classList.toggle('on', i === j));
    }, { passive: true });
    hero = h('div', { class: 'hero' }, track, actions, dots);
  } else {
    hero = h('div', { class: 'hero no-photo' }, actions);
  }

  const makes = r.yieldText || (r.servings ? t('servingsN', r.servings) : '');
  const facts = [
    makes ? [t('makes'), makes] : null,
    r.prepTime ? [t('prep'), r.prepTime] : null,
    r.cookTime ? [t('cook'), r.cookTime] : null,
    r.totalTime ? [t('total'), r.totalTime] : null,
  ].filter(Boolean);

  const body = h('div', { class: 'detail-body' },
    h('h1', {}, r.title),
    tagsRow(r),
    facts.length ? h('div', { class: 'facts' }, facts.map(([k, v]) => h('div', {}, k, h('b', {}, v)))) : null);

  const panel = h('div', { class: 'tab-panel' });
  const tabs = h('div', { class: 'tabs' });
  const tabDefs = [
    ['ingredients', t('ingredients')], ['steps', t('steps')],
    ['notes', t('notes') + (r.notes && r.notes.length ? ` ${r.notes.length}` : '')],
    ['photos', t('photos') + (photos.length ? ` ${photos.length}` : '')],
  ];
  function showTab(name) {
    tabState.set(id, name);
    [...tabs.children].forEach((b) => b.classList.toggle('on', b.dataset.tab === name));
    panel.innerHTML = '';
    if (name === 'ingredients') ingredientsPanel(panel, r);
    if (name === 'steps') stepsPanel(panel, r);
    if (name === 'notes') notesPanel(panel, r, () => renderDetail(id));
    if (name === 'photos') photosPanel(panel, r, photos, () => renderDetail(id));
  }
  for (const [key, label] of tabDefs) tabs.append(h('button', { 'data-tab': key, onclick: () => showTab(key) }, label));

  s.append(hero, body, tabs, panel,
    h('button', { class: 'cook-cta', onclick: () => openCookMode(r) }, icon('flame'), t('startCooking')));
  showTab(tab);
}

// Tags on the recipe page: tap one to see every recipe with it, or "+ Tag"
// to add more. Removing tags is done in the editor, so it can't happen by accident.
function tagsRow(r) {
  const row = h('div', { class: 'tags-row' });
  function draw() {
    row.innerHTML = '';
    for (const tg of r.tags || []) {
      row.append(h('button', { class: 'tag', onclick: () => { homeState.tags = [tg]; homeState.query = ''; homeState.fav = false; go('#/'); } }, tg));
    }
    row.append(h('button', { class: 'tag add', onclick: () => addTagsSheet(r, draw) }, icon('plus', 'sm'), (r.tags || []).length ? t('tag') : t('addTags')));
  }
  draw();
  return row;
}

function addTagsSheet(r, redraw) {
  openSheet((box, close) => {
    const input = h('input', { placeholder: t('tagSheetPlaceholder'), enterkeyhint: 'done', autocapitalize: 'words' });
    const current = h('div', { class: 'tags-row', style: { marginBottom: '14px' } });
    const sug = h('div', { class: 'suggest' });
    const known = allTags().map((x) => x.name);
    const has = (x) => (r.tags || []).some((y) => y.toLowerCase() === x.toLowerCase());
    async function add(raw) {
      const x = raw.trim().replace(/^#/, '');
      if (!x) return;
      const name = known.find((k) => k.toLowerCase() === x.toLowerCase()) || x;
      if (!has(name)) { r.tags = [...(r.tags || []), name]; await db.putRecipe(r); await refresh(); }
      input.value = ''; draw(); redraw(); input.focus();
    }
    function draw() {
      current.innerHTML = '';
      (r.tags || []).forEach((x) => current.append(h('span', { class: 'tag' }, x)));
      if (!(r.tags || []).length) current.append(h('span', { class: 'hint', style: { margin: 0 } }, t('noTagsYet')));
      const q = input.value.trim().toLowerCase();
      sug.innerHTML = '';
      if (q && !known.some((k) => k.toLowerCase() === q) && !has(q)) {
        sug.append(h('button', { class: 'chip on', onclick: () => add(input.value) }, t('createTag', input.value.trim())));
      }
      known.filter((k) => !has(k) && (!q || k.toLowerCase().includes(q))).slice(0, 14)
        .forEach((k) => sug.append(h('button', { class: 'chip', onclick: () => add(k) }, '+ ' + k)));
    }
    input.addEventListener('input', () => { if (input.value.includes(',')) { input.value.split(',').forEach(add); return; } draw(); });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); add(input.value); } });
    box.append(h('h3', {}, t('tags')), current, h('div', { class: 'field' }, input), sug,
      h('div', { style: { height: '16px' } }),
      h('button', { class: 'btn dark block', onclick: () => close() }, t('done')));
    draw();
  });
}

let unitSystem = localStorage.getItem('units') || 'original';

function getScale(id) { return scaleState.get(id) || { factor: 1, note: '' }; }

function ingredientsPanel(panel, r) {
  const sc = getScale(r.id);
  const checks = getChecks(r.id);
  const hasQty = r.ingredients.some((l) => parseIngredient(l).qty != null);

  if (hasQty) {
    const setScale = (factor, note = '') => { scaleState.set(r.id, { factor, note }); panel.innerHTML = ''; ingredientsPanel(panel, r); };
    const top = h('div', { class: 'scaler-top' });
    if (r.servings) {
      const cur = Math.round(r.servings * sc.factor * 100) / 100;
      top.append(
        h('div', { class: 'scaler-label' }, t('servings'), h('b', {}, formatQty(cur))),
        h('div', { class: 'stepper' },
          h('button', { 'aria-label': t('fewer'), onclick: () => { const n = Math.max(1, Math.ceil(cur) - 1); setScale(n / r.servings); } }, '−'),
          h('span', {}, formatQty(cur)),
          h('button', { 'aria-label': t('more'), onclick: () => { const n = Math.floor(cur) + 1; setScale(n / r.servings); } }, '+')));
    } else {
      top.append(h('div', { class: 'scaler-label' }, t('scale'), h('b', {}, '×' + trimNum(sc.factor))));
    }
    const mults = h('div', { class: 'mults' }, [[0.5, '½×'], [1, '1×'], [1.5, '1½×'], [2, '2×'], [3, '3×']].map(([f, l]) =>
      h('button', { class: Math.abs(sc.factor - f) < 1e-6 && !sc.note ? 'on' : '', onclick: () => setScale(f) }, l)));
    const units = h('div', { class: 'units-row' },
      h('span', {}, t('units')),
      h('div', { class: 'seg' }, ['original', 'metric', 'us'].map((k) =>
        h('button', { class: unitSystem === k ? 'on' : '', onclick: () => {
          unitSystem = k; localStorage.setItem('units', k);
          panel.innerHTML = ''; ingredientsPanel(panel, r);
        } }, t('unit_' + k)))));
    const scaler = h('div', { class: 'scaler' }, top, mults, units,
      sc.factor !== 1 ? h('div', { class: 'scale-note' },
        h('span', {}, sc.note ? t('adjustedToMatch', sc.note, trimNum(sc.factor)) : t('scaledBy', trimNum(sc.factor))),
        h('button', { onclick: () => setScale(1) }, t('reset'))) : null);
    panel.append(scaler, h('p', { class: 'hint' }, t('usedHint')));
  }

  const list = h('ul', { class: 'list' });
  r.ingredients.forEach((line, i) => {
    if (isSection(line)) { list.append(h('li', { class: 'sec' }, sectionName(line))); return; }
    const p = scaleIngredient(line, sc.factor, unitSystem);
    const done = checks.i.includes(i);
    const txt = h('div', { class: 'txt' }, ingredientText(p, line));
    const li = h('li', { class: 'item' + (done ? ' done' : '') },
      h('span', { class: 'check' }, icon('check')), txt,
      p.qty != null ? h('button', { class: 'amt-btn', onclick: (e) => { e.stopPropagation(); usedAmount(r, line, p, panel); } }, t('used')) : null);
    li.addEventListener('click', () => {
      const c = getChecks(r.id);
      c.i = c.i.includes(i) ? c.i.filter((x) => x !== i) : [...c.i, i];
      setChecks(r.id, c); li.classList.toggle('done');
    });
    list.append(li);
  });
  if (!r.ingredients.length) list.append(h('p', { class: 'hint' }, t('noIngredients')));
  panel.append(list, resetChecksBtn(r, 'i', panel, () => ingredientsPanel(panel, r)));
}

function ingredientText(p, line) {
  if (p.qty == null) return line;
  return [h('span', { class: 'qty' + (p.scaled ? ' adj' : '') }, p.amountText), p.nameText ? ' ' + p.nameText : ''];
}
const trimNum = (n) => String(Math.round(n * 100) / 100);

async function usedAmount(r, line, p, panel) {
  const val = await promptDialog({
    title: t('howMuchUsed'),
    message: t('howMuchUsedBody', p.display),
    value: p.amountText, ok: t('adjustRecipe'),
  });
  if (val == null || !val.trim()) return;
  const factor = factorFromUsed(val, p);
  if (!factor) { toast(t('cantReadAmount')); return; }
  scaleState.set(r.id, { factor, note: scaleIngredient(line, factor, unitSystem).display });
  panel.innerHTML = '';
  ingredientsPanel(panel, r);
  toast(t('recipeAdjusted'));
}

function resetChecksBtn(r, key, panel, rerender) {
  return h('div', { class: 'list-actions' },
    h('button', { class: 'text-btn', onclick: () => { const c = getChecks(r.id); c[key] = []; setChecks(r.id, c); panel.innerHTML = ''; rerender(); } }, t('clearChecks')));
}

function stepText(text, r, stepIndex) {
  const frag = document.createDocumentFragment();
  let last = 0;
  for (const d of findDurations(text)) {
    frag.append(text.slice(last, d.index));
    frag.append(h('button', {
      class: 'timer-chip',
      onclick: (e) => { e.stopPropagation(); startTimer({ key: `${r.id}:${stepIndex}:${d.index}`, seconds: d.seconds, label: `${r.title} · ${t('stepN', stepIndex + 1)} · ${formatDurationLabel(d.seconds)}` }); },
    }, icon('timer'), d.match));
    last = d.index + d.length;
  }
  frag.append(text.slice(last));
  return frag;
}

function numberedSteps(r) {
  let n = 0; let section = '';
  return r.steps.map((line, i) => {
    if (isSection(line)) { section = sectionName(line); return { head: true, text: section, i }; }
    return { text: line, num: ++n, i, section };
  });
}

function stepsPanel(panel, r) {
  const checks = getChecks(r.id);
  const list = h('ol', { class: 'list' });
  for (const st of numberedSteps(r)) {
    if (st.head) { list.append(h('li', { class: 'sec' }, st.text)); continue; }
    const done = checks.s.includes(st.i);
    const li = h('li', { class: 'item' + (done ? ' done' : '') },
      h('span', { class: 'step-num' }, st.num), h('div', { class: 'txt' }, stepText(st.text, r, st.num - 1)));
    li.addEventListener('click', () => {
      const c = getChecks(r.id);
      c.s = c.s.includes(st.i) ? c.s.filter((x) => x !== st.i) : [...c.s, st.i];
      setChecks(r.id, c); li.classList.toggle('done');
    });
    list.append(li);
  }
  if (!r.steps.length) list.append(h('p', { class: 'hint' }, t('noSteps')));
  panel.append(h('p', { class: 'hint' }, t('stepsHint')), list,
    resetChecksBtn(r, 's', panel, () => stepsPanel(panel, r)));
}

function notesPanel(panel, r, rerenderAll) {
  const ta = h('textarea', { rows: 3, placeholder: t('notePlaceholder') });
  const add = h('button', { class: 'btn sm primary', onclick: async () => {
    const text = ta.value.trim(); if (!text) return;
    r.notes = [{ id: db.uid(), date: Date.now(), text }, ...(r.notes || [])];
    await db.putRecipe(r); await refresh();
    tabState.set(r.id, 'notes'); rerenderAll();
  } }, t('addNote'));
  panel.append(h('div', { class: 'note-new' }, ta, h('div', { class: 'row' }, add)));
  for (const n of r.notes || []) {
    panel.append(h('button', { class: 'note', onclick: () => editNote(r, n, rerenderAll) }, h('time', {}, fmtDate(n.date)), n.text));
  }
  if (!(r.notes || []).length) panel.append(h('p', { class: 'hint' }, t('notesHint')));
}

function editNote(r, n, rerenderAll) {
  openSheet((box, close) => {
    const ta = h('textarea', { rows: 6 }); ta.value = n.text;
    box.append(h('h3', {}, t('editNote')), h('p', {}, fmtDate(n.date)), h('div', { class: 'field' }, ta),
      h('div', { class: 'actions', style: { display: 'flex', justifyContent: 'space-between', marginTop: '16px' } },
        h('button', { class: 'btn sm danger', onclick: () => close('delete') }, icon('trash', 'sm'), t('delete')),
        h('button', { class: 'btn sm primary', onclick: () => close(ta.value) }, t('save'))));
  }).then(async (res) => {
    if (res === undefined) return;
    if (res === 'delete') {
      if (!(await confirmDialog({ title: t('deleteNoteQ'), ok: t('delete'), danger: true }))) return;
      r.notes = r.notes.filter((x) => x.id !== n.id);
    } else n.text = res.trim() || n.text;
    await db.putRecipe(r); tabState.set(r.id, 'notes'); rerenderAll();
  });
}

function photosPanel(panel, r, photos, rerenderAll) {
  const grid = h('div', { class: 'photo-grid' });
  photos.forEach((p, i) => {
    grid.append(h('button', { class: 'photo-tile', onclick: () => openViewer(r, p, i, rerenderAll) },
      h('div', { class: 'ph' }, h('img', { src: p.data, alt: p.caption || '', loading: 'lazy' }), i === 0 ? h('span', { class: 'cover-badge' }, t('cover')) : null),
      p.caption ? h('div', { class: 'cap' }, p.caption) : null,
      h('div', { class: 'date' }, fmtDate(p.date))));
  });
  grid.append(h('button', { class: 'add-tile', onclick: () => addPhotos(r, rerenderAll) }, h('div', {}, icon('camera'), t('addPhotos'))));
  panel.append(h('p', { class: 'hint' }, t('photosHint')), grid);
}

async function addPhotos(r, rerenderAll) {
  const files = await pickFiles({ multiple: true });
  if (!files.length) return;
  toast(t('addingPhotos'));
  for (const f of files) {
    const data = await resizeImage(f);
    const p = await db.putPhoto({ id: db.uid(), recipeId: r.id, data, caption: '', date: Date.now() });
    r.photoIds = [...(r.photoIds || []), p.id];
  }
  await updateThumb(r);
  await db.putRecipe(r); await refresh();
  tabState.set(r.id, 'photos'); rerenderAll();
}

// A text box whose placeholder gently cycles through a few example lines
function rotatingPlaceholder(el, lines, every = 2600) {
  let k = 0;
  el.placeholder = lines[0];
  el.classList.add('rotating');
  const timer = setInterval(() => {
    if (!el.isConnected) { clearInterval(timer); return; }
    if (el.value) return;
    el.classList.add('ph-out');
    setTimeout(() => { k = (k + 1) % lines.length; el.placeholder = lines[k]; el.classList.remove('ph-out'); }, 250);
  }, every);
}

function openViewer(r, p, index, rerenderAll) {
  const dateStr = (ts) => new Date(ts - new Date(ts).getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  openSheet((box, close) => {
    box.className = 'viewer';
    box.innerHTML = '';
    box.append(
      h('div', { class: 'vbar' },
        h('button', { class: 'icon-btn', 'aria-label': t('close'), onclick: () => close() }, icon('x')),
        h('span', {}, fmtDate(p.date))),
      h('img', { src: p.data, alt: '' }),
      p.caption ? h('div', { class: 'vcap' }, p.caption) : h('div', { style: { height: '12px' } }),
      h('div', { class: 'vactions' },
        h('button', { class: 'btn sm', onclick: () => close('caption') }, icon('pen', 'sm'), t('captionDate')),
        index > 0 ? h('button', { class: 'btn sm', onclick: () => close('cover') }, icon('star', 'sm'), t('makeCover')) : null,
        h('button', { class: 'btn sm', onclick: () => close('delete') }, icon('trash', 'sm'), t('delete'))));
  }).then(async (action) => {
    if (action === 'caption') {
      const res = await openSheet((box, close) => {
        const cap = h('textarea', { rows: 3 }); cap.value = p.caption || '';
        rotatingPlaceholder(cap, t('captionIdeas'));
        const date = h('input', { type: 'date', value: dateStr(p.date) });
        box.append(h('h3', {}, t('captionDate')),
          h('div', { class: 'field' }, h('label', {}, t('caption')), cap),
          h('div', { class: 'field', style: { marginTop: '12px' } }, h('label', {}, t('dateMade')), date),
          h('div', { style: { height: '16px' } }),
          h('button', { class: 'btn primary block', onclick: () => close({ caption: cap.value.trim(), date: date.value }) }, t('save')));
      });
      if (!res) return;
      p.caption = res.caption;
      if (res.date) p.date = new Date(res.date + 'T12:00:00').getTime();
      await db.putPhoto(p);
    } else if (action === 'cover') {
      r.photoIds = [p.id, ...r.photoIds.filter((x) => x !== p.id)];
      await updateThumb(r); await db.putRecipe(r); await refresh();
      toast(t('coverUpdated'));
    } else if (action === 'delete') {
      if (!(await confirmDialog({ title: t('deletePhotoQ'), ok: t('delete'), danger: true }))) return;
      await db.deletePhoto(p.id);
      r.photoIds = r.photoIds.filter((x) => x !== p.id);
      await updateThumb(r); await db.putRecipe(r); await refresh();
    } else return;
    tabState.set(r.id, 'photos'); rerenderAll();
  });
}

// =====================================================================
// COOK MODE
// =====================================================================

function openCookMode(r) {
  const steps = numberedSteps(r).filter((s) => !s.head);
  const checks = getChecks(r.id);
  let idx = steps.findIndex((s) => !checks.s.includes(s.i));
  if (idx === -1) idx = 0;
  const sc = getScale(r.id);

  const root = h('div', { class: 'cook' });
  // Cook mode is one step in the back history; popups inside it stack on top
  const ov = pushOverlay(() => {
    keepAwake(false);
    root.remove();
    if (location.hash.startsWith('#/r/')) renderDetail(r.id);
  });
  const exit = () => ov.close();

  keepAwake(true);
  const progress = h('div', { class: 'cook-progress' });
  const bodyEl = h('div', { class: 'cook-body' });
  const nav = h('div', { class: 'cook-nav' });

  function showIngredients() {
    const list = h('ul', { class: 'list' });
    r.ingredients.forEach((line, i) => {
      if (isSection(line)) { list.append(h('li', { class: 'sec' }, sectionName(line))); return; }
      const p = scaleIngredient(line, sc.factor, unitSystem);
      const li = h('li', { class: 'item' + (getChecks(r.id).i.includes(i) ? ' done' : '') }, h('span', { class: 'check' }, icon('check')),
        h('div', { class: 'txt' }, ingredientText(p, line)));
      li.addEventListener('click', () => {
        const c = getChecks(r.id);
        c.i = c.i.includes(i) ? c.i.filter((x) => x !== i) : [...c.i, i];
        setChecks(r.id, c); li.classList.toggle('done');
      });
      list.append(li);
    });
    const panel = h('div', { class: 'cook-ings' });
    const ingOv = pushOverlay(() => panel.remove());
    panel.append(
      h('div', { class: 'cook-head' },
        h('div', { class: 't' }, h('small', {}, sc.factor !== 1 ? t('scaledBy', trimNum(sc.factor)) : t('tapToCheck')), h('b', {}, t('ingredients'))),
        h('button', { class: 'icon-btn', 'aria-label': t('close'), onclick: () => ingOv.close() }, icon('x'))),
      list);
    root.append(panel);
  }

  function draw() {
    const c = getChecks(r.id);
    progress.innerHTML = '';
    steps.forEach((s, i) => progress.append(h('span', { class: i === idx ? 'on' : c.s.includes(s.i) ? 'done' : '' })));
    bodyEl.innerHTML = '';
    nav.innerHTML = '';
    if (idx >= steps.length) {
      bodyEl.append(h('div', { class: 'cook-done-msg' },
        h('h2', {}, t('allDone')),
        h('p', { style: { color: 'var(--muted)', margin: '0 0 22px' } }, t('allDoneBody')),
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px', alignItems: 'center' } },
          h('button', { class: 'btn primary', onclick: () => { tabState.set(r.id, 'photos'); exit(); setTimeout(() => addPhotos(r, () => renderDetail(r.id)), 300); } }, icon('camera'), t('addAPhoto')),
          h('button', { class: 'btn', onclick: () => { tabState.set(r.id, 'notes'); exit(); } }, icon('note'), t('writeANote')))));
      nav.append(
        h('button', { class: 'btn prev', 'aria-label': t('previous'), onclick: () => { idx--; draw(); } }, icon('back')),
        h('button', { class: 'btn dark', onclick: exit }, t('finish')));
      return;
    }
    const st = steps[idx];
    bodyEl.append(h('div', { class: 'cook-step-label' }, t('stepXofY', idx + 1, steps.length)));
    if (st.section) bodyEl.append(h('div', { class: 'cook-sec' }, st.section));
    bodyEl.append(h('div', { class: 'cook-text' }, stepText(st.text, r, st.num - 1)));
    nav.append(
      h('button', { class: 'btn prev', 'aria-label': t('previous'), disabled: idx === 0, onclick: () => { idx--; draw(); } }, icon('back')),
      h('button', { class: 'btn primary', onclick: () => {
        const cc = getChecks(r.id); if (!cc.s.includes(st.i)) cc.s.push(st.i); setChecks(r.id, cc);
        idx++; draw();
      } }, idx === steps.length - 1 ? t('done') : t('nextStep')));
  }

  root.append(
    h('div', { class: 'cook-head' },
      h('button', { class: 'icon-btn', 'aria-label': t('exitCook'), onclick: exit }, icon('x')),
      h('div', { class: 't' }, h('small', {}, t('cookMode')), h('b', {}, r.title)),
      h('button', { class: 'btn sm', onclick: showIngredients }, icon('list', 'sm'), t('ingredients'))),
    progress, bodyEl, nav);
  if (!steps.length) toast(t('noStepsToast'));
  document.body.append(root);
  draw();
}

// =====================================================================
// EDITOR
// =====================================================================

async function renderEditor(id) {
  let existing = null, d;
  if (id) {
    existing = await db.getRecipe(id);
    if (!existing) return go('#/');
    d = { ...existing, photos: await db.getPhotos(existing.photoIds || []), newPhotos: [], removedPhotos: [] };
  } else {
    d = pendingDraft || { title: '', ingredients: [], steps: [], tags: [], newPhotos: [] };
    d.photos = []; d.removedPhotos = [];
    pendingDraft = null;
  }
  // An imported recipe counts as unsaved work from the start
  let dirty = !existing && !!(d.title || (d.ingredients || []).length);
  const markDirty = () => { dirty = true; };

  const s = screen();
  const title = h('input', { class: 'title-input', placeholder: t('recipeName'), value: d.title || '' });

  // photos
  const strip = h('div', { class: 'photo-strip' });
  function drawPhotos() {
    strip.innerHTML = '';
    const items = [...d.photos.map((p) => ({ kind: 'old', p, src: p.data })), ...d.newPhotos.map((data, i) => ({ kind: 'new', i, src: data }))];
    items.forEach((it, n) => strip.append(h('div', { class: 'p' }, h('img', { src: it.src, alt: '' }),
      n === 0 ? h('span', { class: 'cv' }, t('cover')) : null,
      h('button', { class: 'rm', 'aria-label': t('removePhoto'), onclick: () => {
        if (it.kind === 'old') { d.removedPhotos.push(it.p.id); d.photos = d.photos.filter((x) => x !== it.p); }
        else d.newPhotos.splice(it.i, 1);
        markDirty(); drawPhotos();
      } }, icon('x')))));
    strip.append(h('button', { class: 'add', 'aria-label': t('addPhotos'), onclick: async () => {
      const files = await pickFiles({ multiple: true });
      for (const f of files) d.newPhotos.push(await resizeImage(f));
      if (files.length) markDirty();
      drawPhotos();
    } }, icon('camera')));
  }
  drawPhotos();

  // tags (adding and removing both happen here)
  let tags = [...(d.tags || [])];
  const tagInput = h('input', { enterkeyhint: 'done', autocapitalize: 'words' });
  const tagBox = h('div', { class: 'tag-input', onclick: () => tagInput.focus() });
  const suggest = h('div', { class: 'suggest' });
  const known = allTags().map((x) => x.name);
  function addTag(raw) {
    const x = raw.trim().replace(/^#/, '');
    if (!x) return;
    const match = known.find((k) => k.toLowerCase() === x.toLowerCase()) || x;
    if (!tags.some((y) => y.toLowerCase() === match.toLowerCase())) { tags.push(match); markDirty(); }
    tagInput.value = '';
    drawTags();
  }
  function drawTags() {
    tagInput.placeholder = tags.length ? t('addTag') : t('tagPlaceholder');
    tagBox.innerHTML = '';
    for (const tg of tags) {
      tagBox.append(h('button', { class: 'chip', type: 'button', onclick: (e) => { e.stopPropagation(); tags = tags.filter((x) => x !== tg); markDirty(); drawTags(); } },
        tg, h('span', { class: 'x' }, icon('x', 'sm'))));
    }
    tagBox.append(tagInput);
    const q = tagInput.value.trim().toLowerCase();
    const pool = [...new Set([...(d.suggestedTags || []), ...known])];
    const sug = pool.filter((k) => !tags.some((x) => x.toLowerCase() === k.toLowerCase()) && (!q || k.toLowerCase().includes(q))).slice(0, 10);
    suggest.innerHTML = '';
    sug.forEach((k) => suggest.append(h('button', { class: 'chip', type: 'button', onclick: () => { addTag(k); tagInput.focus(); } }, '+ ' + k)));
    if (q && !pool.some((k) => k.toLowerCase() === q)) suggest.prepend(h('button', { class: 'chip on', type: 'button', onclick: () => { addTag(tagInput.value); tagInput.focus(); } }, t('createTag', tagInput.value.trim())));
  }
  tagInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addTag(tagInput.value); }
    if (e.key === 'Backspace' && !tagInput.value && tags.length) { tags.pop(); markDirty(); drawTags(); tagInput.focus(); }
  });
  tagInput.addEventListener('input', () => {
    if (tagInput.value.includes(',')) { tagInput.value.split(',').forEach(addTag); tagInput.focus(); return; }
    const pos = tagInput.value; drawTags(); tagInput.value = pos; tagInput.focus();
  });
  drawTags();

  const servings = h('input', { type: 'number', inputmode: 'numeric', min: 1, placeholder: '4', value: d.servings || '' });
  const yieldText = h('input', { placeholder: t('makesPlaceholder'), value: d.yieldText || '' });
  const prep = h('input', { placeholder: '15 min', value: d.prepTime || '' });
  const cook = h('input', { placeholder: '25 min', value: d.cookTime || '' });
  const total = h('input', { placeholder: '40 min', value: d.totalTime || '' });
  const ings = h('textarea', { class: 'big', placeholder: t('ingredientsPlaceholder') });
  ings.value = (d.ingredients || []).join('\n');
  const steps = h('textarea', { class: 'big', placeholder: t('stepsPlaceholder') });
  steps.value = (d.steps || []).join('\n');

  const lines = (ta) => ta.value.split('\n').map((l) => l.trim()).filter(Boolean);

  async function save() {
    if (tagInput.value.trim()) addTag(tagInput.value);
    d.title = title.value; d.tags = tags;
    d.ingredients = lines(ings); d.steps = lines(steps);
    d.servings = Number(servings.value) || null; d.yieldText = yieldText.value.trim();
    d.prepTime = prep.value.trim(); d.cookTime = cook.value.trim(); d.totalTime = total.value.trim();
    saveBtn.disabled = true;
    const r = await saveDraft(d, existing);
    await refresh();
    backGuard = null;
    toast(existing ? t('saved') : t('recipeAdded'));
    if (existing) history.back();
    else location.replace('#/r/' + r.id);
  }
  const saveBtn = h('button', { class: 'btn primary sm', onclick: save }, t('save'));

  // Leaving with unsaved changes asks first (X button and the phone's back button)
  const confirmLeave = async () => !dirty || confirmDialog({ title: t('discardQ'), ok: t('discard'), cancel: t('keepEditing'), danger: true });
  backGuard = confirmLeave;

  const field = (label, el, help) => h('div', { class: 'field' }, h('label', {}, label), el, help ? h('div', { class: 'help' }, help) : null);

  const form = h('div', { class: 'form' },
    d.suggestedTags ? h('p', { class: 'hint', style: { margin: 0 } }, t('importedHint')) : null,
    field(t('name'), title),
    field(t('photos'), strip, t('photosHelp')),
    h('div', { class: 'field' }, h('label', {}, t('tags')), tagBox, suggest),
    h('div', { class: 'row2' }, field(t('servings'), servings), field(t('makesOptional'), yieldText)),
    h('div', { class: 'row3' }, field(t('prep'), prep), field(t('cook'), cook), field(t('total'), total)),
    field(t('ingredients'), ings, t('ingredientsHelp')),
    field(t('steps'), steps, t('stepsHelp')),
    existing ? h('button', { class: 'btn danger block', onclick: async () => {
      if (!(await confirmDialog({ title: t('deleteRecipeQ'), message: t('deleteRecipeBody'), ok: t('delete'), danger: true }))) return;
      await db.deleteRecipe(existing.id); localStorage.removeItem('checks:' + existing.id);
      backGuard = null;
      await refresh(); toast(t('recipeDeleted')); location.replace('#/'); history.replaceState(null, '', '#/');
    } }, icon('trash', 'sm'), t('deleteRecipe')) : null,
  );
  form.addEventListener('input', (e) => { if (e.target !== tagInput) markDirty(); });

  s.append(
    h('div', { class: 'bar' },
      h('button', { class: 'icon-btn', 'aria-label': t('cancel'), onclick: async () => {
        if (await confirmLeave()) { backGuard = null; history.back(); }
      } }, icon('x')),
      h('h2', {}, existing ? t('editRecipe') : t('newRecipe')), saveBtn),
    form);
  if (!existing && !d.title) title.focus();
}

// =====================================================================
// SETTINGS
// =====================================================================

function applyTheme() {
  const pref = localStorage.getItem('theme') || 'system';
  const dark = pref === 'dark' || (pref === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  document.querySelector('meta[name=theme-color]').setAttribute('content', dark ? '#161210' : '#f5efe5');
}
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);

function renderSettings() {
  const s = screen();
  const pref = localStorage.getItem('theme') || 'system';
  const themeSeg = h('div', { class: 'seg' }, ['system', 'light', 'dark'].map((k) =>
    h('button', { class: k === pref ? 'on' : '', onclick: () => { localStorage.setItem('theme', k); applyTheme(); renderSettings(); } }, t('theme_' + k))));
  const langSeg = h('div', { class: 'seg' }, [['en', 'English'], ['es', 'Español']].map(([k, l]) =>
    h('button', { class: k === getLang() ? 'on' : '', onclick: () => {
      setLang(k); setParserLang(k); renderTimers(); renderSettings();
    } }, l)));

  s.append(
    h('div', { class: 'bar' },
      h('button', { class: 'icon-btn', 'aria-label': t('back'), onclick: () => history.back() }, icon('back')),
      h('h2', {}, t('settings'))),
    h('div', { class: 'form' },
      h('div', {}, h('div', { class: 'group-title' }, t('appearance')),
        h('div', { class: 'group' },
          h('div', { class: 'row-item' }, h('div', {}, t('theme'), h('small', {}, t('themeHelp'))), themeSeg),
          h('div', { class: 'row-item' }, h('div', {}, t('language'), h('small', {}, t('languageHelp'))), langSeg))),
      h('div', {}, h('div', { class: 'group-title' }, t('backup')),
        h('div', { class: 'group' },
          h('button', { class: 'row-item', onclick: exportBackup }, h('div', {}, t('saveBackup'), h('small', {}, t('saveBackupSub', recipes.length))), icon('download')),
          h('button', { class: 'row-item', onclick: importBackup }, h('div', {}, t('restoreBackup'), h('small', {}, t('restoreBackupSub'))), icon('upload'))),
        h('p', { class: 'hint', style: { margin: '8px 4px 0' } }, t('backupHint'))),
    ));
}

async function exportBackup() {
  toast(t('preparingBackup'));
  const data = { app: '300-recipes', version: 1, exported: new Date().toISOString(), recipes: await db.allRecipes(), photos: await db.allPhotos() };
  const name = `300-recipes-backup-${new Date().toISOString().slice(0, 10)}.json`;
  try { await saveFile(name, JSON.stringify(data)); } catch (e) { toast(t('backupNotSaved')); }
}

async function importBackup() {
  const [file] = await pickFiles({ accept: '.json,application/json,text/plain,*/*', multiple: false });
  if (!file) return;
  let data;
  try { data = JSON.parse(await file.text()); } catch { toast(t('notABackup')); return; }
  if (!data || !['300-recipes', 'recipe-box'].includes(data.app) || !Array.isArray(data.recipes)) { toast(t('notABackup')); return; }
  const ok = await confirmDialog({ title: t('restoreQ', data.recipes.length), message: t('restoreBody'), ok: t('restore') });
  if (!ok) return;
  await db.importAll(data.recipes, data.photos || []);
  await refresh();
  toast(t('restoredN', data.recipes.length));
  renderSettings();
}

// =====================================================================
// START
// =====================================================================

window.addEventListener('hashchange', route);
onBackButton(handleBack);
(async function start() {
  applyTheme();
  await refresh();
  initTimers();
  route();
})();
