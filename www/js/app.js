import * as db from './db.js';
import {
  h, icon, openSheet, confirmDialog, promptDialog, toast, pickFiles, resizeImage, fmtDate,
  pushOverlay, hasOverlay,
} from './ui.js';
import {
  scaleIngredient, parseIngredient, formatQty, isSection, sectionName, findDurations,
  formatDurationLabel, recipeMinutes, extractRecipeFromHtml, parsePastedRecipe, factorFromUsed, setParserLang,
} from './parser.js';
import { fetchText, fetchImageDataUrl, saveFile, keepAwake, onBackButton, leaveApp, SiteError } from './native.js';
import { initTimers, startTimer, render as renderTimers } from './timers.js';
import { t, getLang, setLang, locale } from './i18n.js';

const app = document.getElementById('app');

// ---------- app state ----------
let recipes = [];   // recipes in use (not in the recycle bin)
let binList = [];   // recipes in the recycle bin
const SORTS = ['new', 'old', 'az', 'za', 'rated'];
const CSORTS = ['az', 'za', 'new', 'old', 'count'];
const BIN_DAYS = 30;
const DAY = 864e5;
const homeState = { query: '', tags: [], fav: false, top: false, quick: false, fresh: false, sort: SORTS.includes(localStorage.getItem('sort')) ? localStorage.getItem('sort') : 'new' };
let collSort = CSORTS.includes(localStorage.getItem('csort')) ? localStorage.getItem('csort') : 'az';
const scaleState = new Map(); // recipeId -> { factor, note }
const tabState = new Map();   // recipeId -> tab name
let pendingDraft = null;      // imported recipe waiting in the editor
let backGuard = null;         // set by the editor: asks before leaving with unsaved changes

setParserLang(getLang());

async function refresh() {
  const all = await db.allRecipes();
  recipes = all.filter((r) => !r.deleted);
  binList = all.filter((r) => r.deleted).sort((a, b) => b.deleted - a.deleted);
}

// Recipes stay in the recycle bin for 30 days, then they're deleted for good
async function purgeBin() {
  const cutoff = Date.now() - BIN_DAYS * DAY;
  for (const r of await db.allRecipes()) {
    if (r.deleted && r.deleted < cutoff) { await db.deleteRecipe(r.id); localStorage.removeItem('checks:' + r.id); }
  }
}

// ---------- ratings ----------
// The rating is the average of the cook log entries that have stars.
// "Made" counts every entry, rated or not.
function ratingInfo(r) {
  const cooks = r.cooks || [];
  const rated = cooks.filter((c) => c.rating > 0);
  const avg = rated.length ? rated.reduce((a, c) => a + c.rating, 0) / rated.length : null;
  return { avg, rated: rated.length, made: cooks.length };
}
const fmtAvg = (a) => (Math.round(a * 10) / 10).toLocaleString(locale(), { minimumFractionDigits: 1, maximumFractionDigits: 1 });

// Read-only stars; partly filled stars show averages like 4.3
function starsView(value, cls = '') {
  const wrap = h('span', { class: 'stars ' + cls, 'aria-label': value ? fmtAvg(value) + ' / 5' : '' });
  for (let i = 1; i <= 5; i++) {
    const fill = Math.max(0, Math.min(1, (value || 0) - (i - 1)));
    wrap.append(h('span', { class: 'star' }, icon('star'), h('span', { class: 'fill', style: { width: fill * 100 + '%' } }, icon('star'))));
  }
  return wrap;
}

// Tappable half-star rating. Tap the left half of a star for a half star.
// Tapping the current rating again clears it.
function starInput(value, onChange) {
  let v = value || 0;
  const el = h('div', { class: 'star-input' });
  function draw() {
    el.innerHTML = '';
    const row = h('div', { class: 'stars lg' });
    for (let i = 1; i <= 5; i++) {
      const fill = Math.max(0, Math.min(1, v - (i - 1)));
      row.append(h('span', { class: 'star' }, icon('star'), h('span', { class: 'fill', style: { width: fill * 100 + '%' } }, icon('star')),
        h('button', { type: 'button', class: 'half l', 'aria-label': String(i - 0.5), onclick: () => set(i - 0.5) }),
        h('button', { type: 'button', class: 'half r', 'aria-label': String(i), onclick: () => set(i) })));
    }
    el.append(row, h('span', { class: 'star-val' }, v ? fmtAvg(v) : t('notRated')),
      v ? h('button', { type: 'button', class: 'text-btn', onclick: () => set(v) }, t('clear')) : null);
  }
  function set(x) { v = v === x ? 0 : x; draw(); onChange(v); }
  draw();
  return el;
}

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
  if (page === 'c') return id ? renderCollection(decodeURIComponent(id)) : renderCollections();
  if (page === 'bin') return renderBin();
  if (page === 'r' && id) return renderDetail(id);
  if (page === 'edit') return renderEditor(id);
  if (page === 'new') return renderEditor(null);
  if (page === 'settings') return renderSettings();
  renderHome();
}

function screen(...children) {
  app.innerHTML = '';
  document.body.classList.remove('has-nav');
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
  if (hash === '#/c') { location.replace('#/'); return; } // Collections → Recipes, then out
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

const QUICK_MINUTES = 30;
const anyFilter = () => !!(homeState.query.trim() || homeState.tags.length || homeState.fav || homeState.top || homeState.quick || homeState.fresh);
function resetFilters() { homeState.tags = []; homeState.query = ''; homeState.fav = homeState.top = homeState.quick = homeState.fresh = false; }

// The quick filters: favorites, 4★ and up, 30 minutes or less, not made yet
function passesQuick(r) {
  if (homeState.fav && !r.favorite) return false;
  if (homeState.top) { const { avg } = ratingInfo(r); if (avg == null || avg < 4) return false; }
  if (homeState.quick) { const m = recipeMinutes(r); if (m == null || m > QUICK_MINUTES) return false; }
  if (homeState.fresh && ratingInfo(r).made > 0) return false;
  return true;
}

function sortList(list) {
  const byTitle = (a, b) => (a.title || '').localeCompare(b.title || '', locale(), { sensitivity: 'base' });
  if (homeState.sort === 'rated') {
    // Highest average first; recipes without ratings go last
    return list.sort((a, b) => {
      const x = ratingInfo(a), y = ratingInfo(b);
      if ((x.avg == null) !== (y.avg == null)) return x.avg == null ? 1 : -1;
      return (y.avg || 0) - (x.avg || 0) || y.made - x.made || byTitle(a, b);
    });
  }
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
  const timeHint = h('p', { class: 'hint hidden', style: { padding: '8px 20px 0', margin: 0 } });

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
    // quick filters: 4★ and up, 30 minutes or less, not made yet
    if (recipes.length) {
      const q = (key, ic, label, cls = '') => chips.append(h('button', {
        class: 'chip q-chip ' + cls + (homeState[key] ? ' on' : ''), 'aria-pressed': homeState[key] ? 'true' : 'false',
        onclick: () => { homeState[key] = !homeState[key]; update(); },
      }, icon(ic, 'sm'), label));
      q('top', 'star', t('fTop'), 'star');
      q('quick', 'timer', t('fQuick'));
      q('fresh', 'pot', t('fFresh'));
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

    const list = sortList(recipes.filter((r) => passesQuick(r) && matches(r, homeState.query, homeState.tags)));

    sortRow.innerHTML = '';
    sortRow.append(
      h('span', {}, anyFilter() ? t('matches', list.length) : ''),
      h('button', { class: 'sort-btn', onclick: () => openRecipeSort(update) }, t('sort_' + homeState.sort), icon('chevron', 'sm')));
    sortRow.classList.toggle('hidden', !recipes.length);

    const noTime = homeState.quick ? recipes.filter((r) => recipeMinutes(r) == null).length : 0;
    timeHint.textContent = noTime ? t('noTimeHint', noTime) : '';
    timeHint.classList.toggle('hidden', !noTime);

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
        h('p', {}, homeState.fav && !homeState.query && !homeState.tags.length && !homeState.top && !homeState.quick && !homeState.fresh ? t('noFavsYet') : t('tryDifferent'))));
      return;
    }
    for (const r of list) grid.append(card(r));
  }

  s.append(head, search, chips, sortRow, timeHint, grid, empty);
  // Fixed buttons live outside the animated screen so they don't jump on arrival
  app.append(h('button', { class: 'fab', onclick: openAddSheet }, icon('plus'), t('addRecipe')), bottomNav('recipes'));
  update();
}

// Bottom bar: Recipes on the left, Collections on the right
function bottomNav(active) {
  document.body.classList.add('has-nav');
  const item = (key, hash, ic, label) => h('button', {
    class: active === key ? 'on' : '', 'aria-current': active === key ? 'page' : null,
    onclick: () => { if (active !== key) location.replace(hash); else window.scrollTo({ top: 0, behavior: 'smooth' }); },
  }, h('span', { class: 'pill' }, icon(ic)), label);
  return h('nav', { class: 'bottom-nav' },
    item('recipes', '#/', 'pot', t('recipes')),
    item('collections', '#/c', 'collections', t('collections')));
}

function sortSheet(keys, current, labelKey) {
  return openSheet((box, close) => {
    box.append(h('h3', { style: { marginBottom: '14px' } }, t('sortBy')));
    for (const k of keys) {
      const on = current === k;
      box.append(h('button', { class: 'option sort-opt' + (on ? ' on' : ''), onclick: () => close(k) },
        h('b', {}, t(labelKey + k)), on ? icon('check') : null));
    }
  });
}

function openRecipeSort(update) {
  sortSheet(SORTS, homeState.sort, 'sort_').then((k) => {
    if (!k) return;
    homeState.sort = k;
    localStorage.setItem('sort', k);
    update();
  });
}

// =====================================================================
// COLLECTIONS (one per tag, plus Favorites and Untagged)
// =====================================================================

const FAV_KEY = '~fav', UNTAGGED_KEY = '~untagged';

function collections() {
  const map = new Map();
  for (const r of recipes) for (const tg of r.tags || []) {
    const k = tg.toLowerCase();
    const c = map.get(k) || { key: tg, name: tg, list: [] };
    c.list.push(r); map.set(k, c);
  }
  return [...map.values()];
}

function collectionList(key) {
  if (key === FAV_KEY) return { name: t('favorites'), list: recipes.filter((r) => r.favorite) };
  if (key === UNTAGGED_KEY) return { name: t('untagged'), list: recipes.filter((r) => !(r.tags || []).length) };
  const k = key.toLowerCase();
  const list = recipes.filter((r) => (r.tags || []).some((x) => x.toLowerCase() === k));
  const name = list.length ? list[0].tags.find((x) => x.toLowerCase() === k) : key;
  return { name, list };
}

function sortCollections(cols) {
  const byName = (a, b) => a.name.localeCompare(b.name, locale(), { sensitivity: 'base' });
  const newest = (c) => Math.max(...c.list.map((r) => r.created || 0));
  const oldest = (c) => Math.min(...c.list.map((r) => r.created || 0));
  if (collSort === 'za') return cols.sort((a, b) => byName(b, a));
  if (collSort === 'new') return cols.sort((a, b) => newest(b) - newest(a) || byName(a, b));
  if (collSort === 'old') return cols.sort((a, b) => oldest(a) - oldest(b) || byName(a, b));
  if (collSort === 'count') return cols.sort((a, b) => b.list.length - a.list.length || byName(a, b));
  return cols.sort(byName);
}

function collectionCard(key, name, list, extra = {}) {
  const newestFirst = [...list].sort((a, b) => (b.created || 0) - (a.created || 0));
  const thumbs = newestFirst.map((r) => r.thumb).filter(Boolean);
  let cover;
  if (extra.untagged) {
    cover = h('div', { class: 'cover hint-cover' }, icon('tag'), h('span', {}, t('untaggedHint')));
  } else if (thumbs.length >= 4) {
    cover = h('div', { class: 'cover mosaic' }, thumbs.slice(0, 4).map((src) => h('img', { src, alt: '', loading: 'lazy' })));
  } else if (thumbs.length) {
    cover = h('div', { class: 'cover' }, h('img', { src: thumbs[0], alt: '', loading: 'lazy' }));
  } else {
    cover = h('div', { class: 'cover' }, h('div', { class: 'placeholder' }, extra.fav ? icon('heart') : (name || '?').trim()[0].toUpperCase()));
  }
  if (extra.fav) cover.append(h('span', { class: 'coll-badge' }, icon('heart', 'sm')));
  return h('div', { class: 'coll' + (extra.fav ? ' fav' : '') + (extra.untagged ? ' untagged' : ''), role: 'button', tabindex: 0, onclick: () => go('#/c/' + encodeURIComponent(key)) },
    cover, h('h3', {}, name), h('div', { class: 'meta' }, t('recipeCount', list.length)));
}

function renderCollections() {
  const s = screen();
  const cols = sortCollections(collections());
  const favs = recipes.filter((r) => r.favorite);
  const untagged = recipes.filter((r) => !(r.tags || []).length);

  const head = h('header', { class: 'home-head' },
    h('div', {}, h('h1', {}, t('collections')), h('div', { class: 'count' }, t('collectionCount', cols.length))),
    h('button', { class: 'icon-btn', 'aria-label': t('settings'), onclick: () => go('#/settings') }, icon('settings')));
  s.append(head);

  if (!recipes.length) {
    s.append(h('div', { class: 'empty' }, h('h3', {}, t('noCollectionsTitle')), h('p', {}, t('noCollectionsBody'))));
    app.append(bottomNav('collections'));
    return;
  }
  const sortRow = h('div', { class: 'sort-row' },
    h('span', {}),
    h('button', { class: 'sort-btn', onclick: () => sortSheet(CSORTS, collSort, 'csort_').then((k) => {
      if (!k) return; collSort = k; localStorage.setItem('csort', k); renderCollections();
    }) }, t('csort_' + collSort), icon('chevron', 'sm')));
  const grid = h('div', { class: 'grid coll-grid' });
  // Favorites always first, Untagged always last
  grid.append(collectionCard(FAV_KEY, t('favorites'), favs, { fav: true }));
  for (const c of cols) grid.append(collectionCard(c.key, c.name, c.list));
  if (untagged.length) grid.append(collectionCard(UNTAGGED_KEY, t('untagged'), untagged, { untagged: true }));
  s.append(sortRow, grid, !cols.length ? h('p', { class: 'hint', style: { padding: '0 20px' } }, t('noTagsCollectionsHint')) : null);
  app.append(bottomNav('collections'));
}

function renderCollection(key) {
  const s = screen();
  const { name, list } = collectionList(key);
  const grid = h('div', { class: 'grid' });
  const sortBtn = h('button', { class: 'sort-btn' });
  function draw() {
    sortBtn.innerHTML = ''; sortBtn.append(t('sort_' + homeState.sort), icon('chevron', 'sm'));
    grid.innerHTML = '';
    for (const r of sortList([...list])) grid.append(card(r));
  }
  sortBtn.addEventListener('click', () => openRecipeSort(draw));
  s.append(
    h('div', { class: 'bar' },
      h('button', { class: 'icon-btn', 'aria-label': t('back'), onclick: () => (history.length > 1 ? history.back() : go('#/c')) }, icon('back')),
      h('h2', {}, name)),
    key === UNTAGGED_KEY && list.length ? h('p', { class: 'hint', style: { padding: '0 20px', margin: '4px 0 0' } }, t('untaggedBody')) : null,
    list.length ? h('div', { class: 'sort-row' }, h('span', {}, t('recipeCount', list.length)), sortBtn) : null,
    grid,
    !list.length ? h('div', { class: 'empty' }, h('h3', {}, t('nothingHere')),
      h('p', {}, key === FAV_KEY ? t('noFavsYet') : t('collectionEmpty'))) : null);
  draw();
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
  const { avg } = ratingInfo(r);
  const rating = avg != null ? h('span', { class: 'card-rating' }, icon('star'), fmtAvg(avg)) : null;
  return h('div', { class: 'card', role: 'button', tabindex: 0, onclick: () => go('#/r/' + r.id) }, ph, h('h3', {}, r.title),
    tags || rating ? h('div', { class: 'meta' }, rating, rating && tags ? ' · ' : null, tags || null) : null);
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
  if (!r || r.deleted) return go('#/');
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

  const info = ratingInfo(r);
  const ratingLine = info.made ? h('button', { class: 'rating-line', onclick: () => { showTab('cooklog'); tabs.scrollIntoView({ behavior: 'smooth' }); } },
    info.avg != null ? [starsView(info.avg), h('b', {}, fmtAvg(info.avg)), h('span', { class: 'dot' }, '·')] : null,
    h('span', {}, t('madeN', info.made))) : null;

  const body = h('div', { class: 'detail-body' },
    h('h1', {}, r.title),
    ratingLine,
    tagsRow(r),
    facts.length ? h('div', { class: 'facts' }, facts.map(([k, v]) => h('div', {}, k, h('b', {}, v)))) : null);

  const panel = h('div', { class: 'tab-panel' });
  const tabs = h('div', { class: 'tabs' });
  const tabDefs = [
    ['ingredients', t('ingredients')], ['steps', t('steps')],
    ['cooklog', t('cookLog'), info.made],
    ['notes', t('notes'), (r.notes || []).length],
    ['photos', t('photos'), photos.length],
  ];
  function showTab(name) {
    tabState.set(id, name);
    [...tabs.children].forEach((b) => b.classList.toggle('on', b.dataset.tab === name));
    const on = tabs.querySelector('.on');
    if (on) tabs.scrollTo({ left: on.offsetLeft - tabs.clientWidth / 2 + on.offsetWidth / 2, behavior: 'smooth' });
    panel.innerHTML = '';
    if (name === 'ingredients') ingredientsPanel(panel, r);
    if (name === 'steps') stepsPanel(panel, r);
    if (name === 'cooklog') cookLogPanel(panel, r, () => renderDetail(id));
    if (name === 'notes') notesPanel(panel, r, () => renderDetail(id));
    if (name === 'photos') photosPanel(panel, r, photos, () => renderDetail(id));
  }
  for (const [key, label, n] of tabDefs) {
    tabs.append(h('button', { 'data-tab': key, onclick: () => showTab(key) }, label, n ? h('span', { class: 'tab-n' }, n) : null));
  }

  s.append(hero, body, tabs, panel);
  app.append(h('button', { class: 'cook-cta', onclick: () => openCookMode(r) }, icon('flame'), t('startCooking')));
  showTab(tab);
}

// Tags on the recipe page: tap one to see every recipe with it, or "+ Tag"
// to add more. Removing tags is done in the editor, so it can't happen by accident.
function tagsRow(r) {
  const row = h('div', { class: 'tags-row' });
  function draw() {
    row.innerHTML = '';
    for (const tg of r.tags || []) {
      row.append(h('button', { class: 'tag', onclick: () => { resetFilters(); homeState.tags = [tg]; go('#/'); } }, tg));
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

// ---------- Cook log ----------
// Each entry: { id, date, rating (0.5–5, or 0 for none), text, photoIds }
// Entry photos stay off the recipe card unless "Add to recipe photos" is on.

async function cookLogPanel(panel, r, rerenderAll) {
  const info = ratingInfo(r);
  const entries = [...(r.cooks || [])].sort((a, b) => b.date - a.date);
  const photoMap = new Map((await db.getPhotos(entries.flatMap((c) => c.photoIds || []))).map((p) => [p.id, p]));
  if (!panel.isConnected) return;

  if (info.made) {
    panel.append(h('div', { class: 'cook-summary' },
      h('div', { class: 'cs-rating' },
        h('div', { class: 'big' }, info.avg != null ? fmtAvg(info.avg) : '–'),
        h('div', {}, starsView(info.avg || 0), h('small', {}, info.avg != null ? t('fromRatings', info.rated) : t('noRatingsYet')))),
      h('div', { class: 'cs-made' }, h('b', {}, info.made), h('small', {}, t('timesMade', info.made)))));
  }
  panel.append(h('button', { class: 'btn primary block', style: { marginBottom: '16px' }, onclick: () => cookEntrySheet(r.id, null, rerenderAll) },
    icon('plus', 'sm'), t('logACook')));

  for (const c of entries) {
    const ps = (c.photoIds || []).map((id) => photoMap.get(id)).filter(Boolean);
    panel.append(h('button', { class: 'note cook-entry', onclick: () => cookEntrySheet(r.id, c.id, rerenderAll) },
      h('div', { class: 'ce-head' }, h('time', {}, fmtDate(c.date)), c.rating ? starsView(c.rating, 'sm') : h('small', {}, t('notRated'))),
      c.text ? h('div', { class: 'ce-text' }, c.text) : null,
      ps.length ? h('div', { class: 'ce-photos' }, ps.map((p) => h('img', { src: p.data, alt: '', loading: 'lazy' }))) : null));
  }
  if (!entries.length) panel.append(h('p', { class: 'hint' }, t('cookLogHint')));
}

async function cookEntrySheet(recipeId, entryId, after) {
  const r = await db.getRecipe(recipeId);
  if (!r) return;
  r.cooks = r.cooks || [];
  const entry = entryId ? r.cooks.find((c) => c.id === entryId) : null;
  const dateStr = (ts) => new Date(ts - new Date(ts).getTimezoneOffset() * 60000).toISOString().slice(0, 10);

  // Photos in this sheet: existing ones (by id) and new ones (data only)
  const existing = entry ? await db.getPhotos(entry.photoIds || []) : [];
  let items = existing.map((p) => ({ id: p.id, src: p.data, toRecipe: (r.photoIds || []).includes(p.id) }));
  const removed = [];
  let rating = entry ? entry.rating || 0 : 0;

  const res = await openSheet((box, close) => {
    const date = h('input', { type: 'date', value: dateStr(entry ? entry.date : Date.now()) });
    const text = h('textarea', { rows: 4 });
    text.value = entry ? entry.text || '' : '';
    rotatingPlaceholder(text, t('cookNoteIdeas'));
    const strip = h('div', { class: 'ce-strip' });
    function drawPhotos() {
      strip.innerHTML = '';
      for (const it of items) {
        strip.append(h('div', { class: 'ce-ph' },
          h('div', { class: 'p' }, h('img', { src: it.src, alt: '' }),
            h('button', { type: 'button', class: 'rm', 'aria-label': t('removePhoto'), onclick: () => {
              if (it.id) removed.push(it.id);
              items = items.filter((x) => x !== it); drawPhotos();
            } }, icon('x'))),
          h('button', { type: 'button', class: 'to-recipe' + (it.toRecipe ? ' on' : ''), onclick: () => { it.toRecipe = !it.toRecipe; drawPhotos(); } },
            it.toRecipe ? icon('check', 'sm') : icon('plus', 'sm'), it.toRecipe ? t('inRecipePhotos') : t('addToRecipePhotos'))));
      }
      strip.append(h('button', { type: 'button', class: 'add', 'aria-label': t('addPhotos'), onclick: async () => {
        const files = await pickFiles({ multiple: true });
        for (const f of files) items.push({ src: await resizeImage(f), toRecipe: false });
        drawPhotos();
      } }, icon('camera')));
    }
    drawPhotos();
    box.append(
      h('h3', {}, entry ? t('editCook') : t('logACook')),
      h('div', { class: 'field' }, h('label', {}, t('ratingOptional')), starInput(rating, (v) => { rating = v; })),
      h('div', { class: 'field', style: { marginTop: '12px' } }, h('label', {}, t('dateMade')), date),
      h('div', { class: 'field', style: { marginTop: '12px' } }, h('label', {}, t('howDidItGo')), text),
      h('div', { class: 'field', style: { marginTop: '12px' } }, h('label', {}, t('photos')), strip,
        h('div', { class: 'help' }, t('cookPhotosHelp'))),
      h('div', { class: 'actions', style: { display: 'flex', justifyContent: entry ? 'space-between' : 'flex-end', gap: '10px', marginTop: '18px' } },
        entry ? h('button', { class: 'btn sm danger', onclick: () => close('delete') }, icon('trash', 'sm'), t('delete')) : null,
        h('button', { class: 'btn sm primary', onclick: () => close({ date: date.value, text: text.value.trim() }) }, t('save'))));
  });
  if (!res) return;

  // Re-read in case something changed while the sheet was open
  const fresh = await db.getRecipe(recipeId);
  fresh.cooks = fresh.cooks || [];
  fresh.photoIds = fresh.photoIds || [];
  const usedElsewhere = (pid) => fresh.photoIds.includes(pid);

  if (res === 'delete') {
    if (!(await confirmDialog({ title: t('deleteCookQ'), message: t('deleteCookBody'), ok: t('delete'), danger: true }))) return;
    const old = fresh.cooks.find((c) => c.id === entryId);
    for (const pid of (old && old.photoIds) || []) if (!usedElsewhere(pid)) await db.deletePhoto(pid);
    fresh.cooks = fresh.cooks.filter((c) => c.id !== entryId);
  } else {
    const when = res.date ? new Date(res.date + 'T12:00:00').getTime() : Date.now();
    const ids = [];
    for (const it of items) {
      if (!it.id) {
        const p = await db.putPhoto({ id: db.uid(), recipeId, data: it.src, caption: '', date: when });
        it.id = p.id;
      }
      ids.push(it.id);
      const inRecipe = fresh.photoIds.includes(it.id);
      if (it.toRecipe && !inRecipe) fresh.photoIds.push(it.id);
      if (!it.toRecipe && inRecipe) fresh.photoIds = fresh.photoIds.filter((x) => x !== it.id);
    }
    // Photos removed from the entry are deleted unless they're still on the recipe card
    for (const pid of removed) if (!usedElsewhere(pid)) await db.deletePhoto(pid);
    const data = { date: when, rating: rating || 0, text: res.text, photoIds: ids };
    if (entryId) fresh.cooks = fresh.cooks.map((c) => (c.id === entryId ? { ...c, ...data } : c));
    else fresh.cooks.push({ id: db.uid(), ...data });
  }
  await updateThumb(fresh);
  await db.putRecipe(fresh); await refresh();
  toast(res === 'delete' ? t('cookDeleted') : entryId ? t('saved') : t('cookLogged'));
  tabState.set(recipeId, 'cooklog');
  after();
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
      // A photo that also belongs to a cook log entry stays there
      const inLog = (r.cooks || []).some((c) => (c.photoIds || []).includes(p.id));
      if (!(await confirmDialog({ title: inLog ? t('removePhotoQ') : t('deletePhotoQ'), message: inLog ? t('removePhotoBody') : '', ok: inLog ? t('remove') : t('delete'), danger: true }))) return;
      if (!inLog) await db.deletePhoto(p.id);
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
          h('button', { class: 'btn primary', onclick: () => { tabState.set(r.id, 'cooklog'); exit(); setTimeout(() => cookEntrySheet(r.id, null, () => renderDetail(r.id)), 350); } }, icon('star'), t('logThisCook')),
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
    existing ? h('div', { class: 'editor-actions' },
      h('button', { class: 'btn primary block', onclick: async () => {
        if (dirty && !(await confirmDialog({ title: t('duplicateUnsavedQ'), message: t('duplicateUnsavedBody'), ok: t('duplicate') }))) return;
        const copy = await duplicateRecipe(existing.id);
        backGuard = null;
        await refresh(); toast(t('duplicated'));
        location.replace('#/r/' + copy.id);
      } }, icon('copy', 'sm'), t('duplicateRecipe')),
      h('button', { class: 'btn danger block', onclick: async () => {
        if (!(await confirmDialog({ title: t('deleteRecipeQ'), ok: t('delete'), danger: true }))) return;
        const fresh = await db.getRecipe(existing.id);
        fresh.deleted = Date.now();
        await db.putRecipe(fresh);
        backGuard = null;
        await refresh(); toast(t('movedToBin')); location.replace('#/'); history.replaceState(null, '', '#/');
      } }, icon('trash', 'sm'), t('deleteRecipe'))) : null,
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

// Copies everything except the cook log, so the copy starts with a fresh rating
async function duplicateRecipe(id) {
  const src = await db.getRecipe(id);
  const copy = JSON.parse(JSON.stringify(src));
  copy.id = db.uid();
  copy.title = t('copyTitle', src.title);
  copy.cooks = [];
  copy.favorite = false;
  delete copy.created; delete copy.updated; delete copy.deleted;
  copy.notes = (src.notes || []).map((n) => ({ ...n, id: db.uid() }));
  copy.photoIds = [];
  for (const p of await db.getPhotos(src.photoIds || [])) {
    const np = await db.putPhoto({ ...p, id: db.uid(), recipeId: copy.id });
    copy.photoIds.push(np.id);
  }
  await db.putRecipe(copy);
  return copy;
}

// =====================================================================
// RECYCLE BIN
// =====================================================================

function renderBin() {
  const s = screen();
  const bar = h('div', { class: 'bar' },
    h('button', { class: 'icon-btn', 'aria-label': t('back'), onclick: () => (history.length > 1 ? history.back() : go('#/settings')) }, icon('back')),
    h('h2', {}, t('recycleBin')),
    binList.length ? h('button', { class: 'btn sm danger', onclick: async () => {
      if (!(await confirmDialog({ title: t('emptyBinQ', binList.length), message: t('cantUndo'), ok: t('emptyBin'), danger: true }))) return;
      for (const r of binList) { await db.deleteRecipe(r.id); localStorage.removeItem('checks:' + r.id); }
      await refresh(); toast(t('binEmptied')); renderBin();
    } }, t('emptyBin')) : null);
  s.append(bar);
  if (!binList.length) {
    s.append(h('div', { class: 'empty' }, h('h3', {}, t('binEmptyTitle')), h('p', {}, t('binEmptyBody'))));
    return;
  }
  const list = h('div', { class: 'bin-list' });
  for (const r of binList) {
    const daysLeft = Math.max(1, Math.ceil((r.deleted + BIN_DAYS * DAY - Date.now()) / DAY));
    list.append(h('div', { class: 'bin-item' },
      h('div', { class: 'bin-ph' }, r.thumb ? h('img', { src: r.thumb, alt: '' }) : h('div', { class: 'placeholder' }, (r.title || '?').trim()[0].toUpperCase())),
      h('div', { class: 'bin-txt' }, h('b', {}, r.title), h('small', {}, t('deletesInDays', daysLeft))),
      h('button', { class: 'btn sm', onclick: async () => {
        const fresh = await db.getRecipe(r.id);
        delete fresh.deleted;
        await db.putRecipe(fresh); await refresh();
        toast(t('restoredRecipe')); renderBin();
      } }, t('restore')),
      h('button', { class: 'icon-btn', 'aria-label': t('deleteForever'), onclick: async () => {
        if (!(await confirmDialog({ title: t('deleteForeverQ'), message: t('cantUndo'), ok: t('deleteForever'), danger: true }))) return;
        await db.deleteRecipe(r.id); localStorage.removeItem('checks:' + r.id);
        await refresh(); toast(t('deletedForever')); renderBin();
      } }, icon('trash'))));
  }
  s.append(h('p', { class: 'hint', style: { padding: '4px 20px 0' } }, t('binHint')), list);
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
      h('div', {}, h('div', { class: 'group-title' }, t('recycleBin')),
        h('div', { class: 'group' },
          h('button', { class: 'row-item', onclick: () => go('#/bin') },
            h('div', {}, t('recycleBin'), h('small', {}, binList.length ? t('binSub', binList.length) : t('binSubEmpty'))), icon('trash')))),
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
  try { await purgeBin(); } catch { /* try again next start */ }
  await refresh();
  initTimers();
  route();
})();
