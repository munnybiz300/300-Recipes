import * as db from './db.js';
import { h, icon, openSheet, confirmDialog, promptDialog, toast, pickFiles, resizeImage, fmtDate } from './ui.js';
import {
  scaleIngredient, parseIngredient, formatQty, isSection, sectionName, findDurations,
  formatDurationLabel, extractRecipeFromHtml, parsePastedRecipe, factorFromUsed,
} from './parser.js';
import { fetchText, fetchImageDataUrl, saveFile, keepAwake } from './native.js';
import { initTimers, startTimer } from './timers.js';

const app = document.getElementById('app');

// ---------- app state ----------
let recipes = [];
const homeState = { query: '', tags: [], fav: false, sort: localStorage.getItem('sort') || 'new' };
const scaleState = new Map(); // recipeId -> { factor, note }
const tabState = new Map();   // recipeId -> tab name
let pendingDraft = null;      // imported recipe waiting in the editor

async function refresh() { recipes = await db.allRecipes(); }

function allTags() {
  const counts = new Map();
  for (const r of recipes) for (const t of r.tags || []) {
    const k = t.toLowerCase();
    const cur = counts.get(k) || { name: t, count: 0 };
    cur.count++; counts.set(k, cur);
  }
  return [...counts.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

function go(hash) { if (location.hash !== hash) location.hash = hash; else route(); }

// ---------- router ----------
async function route() {
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

// =====================================================================
// HOME
// =====================================================================

function matches(r, q, tagFilter) {
  const tags = (r.tags || []).map((t) => t.toLowerCase());
  for (const t of tagFilter) if (!tags.includes(t.toLowerCase())) return false;
  const tokens = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!tokens.length) return true;
  const title = (r.title || '').toLowerCase();
  const ings = (r.ingredients || []).join(' ').toLowerCase();
  return tokens.every((tok) => {
    if (tok.startsWith('#')) { const t = tok.slice(1); return tags.some((x) => x.includes(t)); }
    return title.includes(tok) || tags.some((x) => x.includes(tok)) || ings.includes(tok);
  });
}

function renderHome() {
  const s = screen();
  const head = h('header', { class: 'home-head' },
    h('div', {}, h('h1', {}, 'Recipes'), h('div', { class: 'count' }, countLabel(recipes.length))),
    h('button', { class: 'icon-btn', 'aria-label': 'Settings', onclick: () => go('#/settings') }, icon('settings')));

  const input = h('input', { type: 'search', placeholder: 'Search recipes, tags, ingredients', value: homeState.query, enterkeyhint: 'search' });
  const clearBtn = h('button', { class: 'icon-btn', style: { width: '32px', height: '32px' }, 'aria-label': 'Clear', onclick: () => { input.value = ''; homeState.query = ''; update(); input.focus(); } }, icon('x', 'sm'));
  const search = h('div', { class: 'search-wrap' }, h('label', { class: 'search' }, icon('search'), input, clearBtn));
  const chips = h('div', { class: 'chips' });
  const sortRow = h('div', { class: 'sort-row' });
  const grid = h('div', { class: 'grid' });
  const empty = h('div');

  input.addEventListener('input', () => { homeState.query = input.value; update(); });

  function update() {
    clearBtn.classList.toggle('hidden', !homeState.query);
    // tags: selected first, then ones that match the search text
    chips.innerHTML = '';
    const favCount = recipes.filter((r) => r.favorite).length;
    if (favCount || homeState.fav) {
      chips.append(h('button', {
        class: 'chip fav-chip' + (homeState.fav ? ' on' : ''),
        onclick: () => { homeState.fav = !homeState.fav; update(); },
      }, icon('heart', 'sm'), 'Favorites'));
    }
    const q = homeState.query.trim().toLowerCase().replace(/^#/, '');
    const sel = homeState.tags.map((t) => t.toLowerCase());
    let tags = allTags();
    if (q) tags = [...tags.filter((t) => t.name.toLowerCase().includes(q)), ...tags.filter((t) => !t.name.toLowerCase().includes(q))];
    tags = [...tags.filter((t) => sel.includes(t.name.toLowerCase())), ...tags.filter((t) => !sel.includes(t.name.toLowerCase()))];
    for (const t of tags) {
      const on = sel.includes(t.name.toLowerCase());
      chips.append(h('button', {
        class: 'chip' + (on ? ' on' : ''),
        onclick: () => {
          homeState.tags = on ? homeState.tags.filter((x) => x.toLowerCase() !== t.name.toLowerCase()) : [...homeState.tags, t.name];
          update(); chips.scrollTo({ left: 0, behavior: 'smooth' });
        },
      }, t.name, on ? icon('x', 'sm') : null));
    }
    chips.classList.toggle('hidden', !chips.children.length);

    let list = recipes.filter((r) => (!homeState.fav || r.favorite) && matches(r, homeState.query, homeState.tags));
    if (homeState.sort === 'az') list.sort((a, b) => a.title.localeCompare(b.title));
    else list.sort((a, b) => b.created - a.created);

    sortRow.innerHTML = '';
    sortRow.append(
      h('span', {}, homeState.query || homeState.tags.length || homeState.fav ? `${list.length} match${list.length === 1 ? '' : 'es'}` : ''),
      h('button', { onclick: () => { homeState.sort = homeState.sort === 'az' ? 'new' : 'az'; localStorage.setItem('sort', homeState.sort); update(); } },
        homeState.sort === 'az' ? 'Sorted A–Z' : 'Newest first'));
    sortRow.classList.toggle('hidden', !recipes.length);

    grid.innerHTML = '';
    empty.innerHTML = '';
    if (!recipes.length) {
      empty.append(h('div', { class: 'empty' },
        h('h3', {}, 'No recipes yet'),
        h('p', {}, 'Import one from a website, paste one in, or write your own.'),
        h('button', { class: 'btn primary', onclick: openAddSheet }, icon('plus'), 'Add your first recipe')));
      return;
    }
    if (!list.length) {
      empty.append(h('div', { class: 'empty' }, h('h3', {}, 'Nothing found'), h('p', {}, homeState.fav && !homeState.query && !homeState.tags.length ? 'Tap the heart on a recipe to add it here.' : 'Try a different word, or remove a filter.')));
      return;
    }
    for (const r of list) grid.append(card(r));
  }

  s.append(head, search, chips, sortRow, grid, empty,
    h('button', { class: 'fab', onclick: openAddSheet }, icon('plus'), 'Add recipe'));
  update();
}

const countLabel = (n) => `${n} recipe${n === 1 ? '' : 's'}`;

function card(r) {
  const ph = h('div', { class: 'ph' },
    r.thumb ? h('img', { src: r.thumb, alt: '', loading: 'lazy' }) : h('div', { class: 'placeholder' }, (r.title || '?').trim()[0].toUpperCase()));
  const heart = h('button', {
    class: 'card-heart' + (r.favorite ? ' on' : ''), 'aria-label': r.favorite ? 'Remove from favorites' : 'Add to favorites',
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
      h('h3', {}, 'Add a recipe'),
      h('p', {}, 'No limits, no ads.'),
      opt('link', 'Import from a website', 'Paste a link, or several at once', importFromWeb),
      opt('clipboard', 'Paste recipe text', 'From a note, message, or cookbook photo text', importFromText),
      opt('pen', 'Write it myself', 'Start with a blank recipe', () => { pendingDraft = null; go('#/new'); }),
    );
  }).then((fn) => fn && fn());
}

async function importOne(url) {
  const html = await fetchText(url);
  const data = extractRecipeFromHtml(html, url);
  if (!data) throw new Error("Couldn't find a recipe on that page.");
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

function importFromWeb() {
  openSheet((box, close) => {
    const ta = h('textarea', { rows: 3, placeholder: 'https://…', autocapitalize: 'off', spellcheck: false });
    const err = h('div', { class: 'error' });
    const btn = h('button', { class: 'btn primary block' }, 'Import');
    const status = h('p', { class: 'hidden' });
    btn.addEventListener('click', async () => {
      const urls = (ta.value.match(/https?:\/\/[^\s<>"']+/g) || []);
      err.textContent = '';
      if (!urls.length) { err.textContent = 'Paste a link that starts with http.'; return; }
      btn.disabled = true;
      btn.innerHTML = ''; btn.append(h('span', { class: 'spinner' }), urls.length > 1 ? 'Importing…' : 'Getting recipe…');
      if (urls.length === 1) {
        try {
          pendingDraft = await importOne(urls[0]);
          close('edit');
        } catch (e) {
          err.textContent = friendlyError(e) + ' You can use "Paste recipe text" instead.';
          btn.disabled = false; btn.textContent = 'Try again';
        }
        return;
      }
      // Several links: save each one straight away
      let ok = 0; const failed = [];
      status.classList.remove('hidden');
      for (let i = 0; i < urls.length; i++) {
        status.textContent = `Importing ${i + 1} of ${urls.length}…`;
        try { await saveDraft(await importOne(urls[i]), null); ok++; } catch { failed.push(urls[i]); }
      }
      await refresh();
      if (failed.length) {
        status.textContent = `Imported ${ok}. These didn't work:`;
        ta.value = failed.join('\n');
        btn.disabled = false; btn.textContent = 'Retry these';
        err.textContent = '';
      } else {
        toast(`Imported ${ok} recipes`);
        close('home');
      }
    });
    box.append(
      h('h3', {}, 'Import from a website'),
      h('p', {}, 'Paste a recipe link. Paste several links (one per line) to import a batch, then add tags later.'),
      h('div', { class: 'field' }, ta), err, status,
      h('div', { style: { height: '14px' } }), btn);
  }).then((r) => {
    if (r === 'edit') go('#/new');
    else if (r === 'home') { if (location.hash.length > 2) go('#/'); else renderHome(); }
  });
}

function friendlyError(e) {
  const m = String(e && e.message || e);
  if (/Failed to fetch|NetworkError|network/i.test(m)) return "Couldn't reach that site. Check your connection.";
  return m;
}

function importFromText() {
  openSheet((box, close) => {
    const ta = h('textarea', { rows: 10, placeholder: 'Recipe title\n\nIngredients\n2 cups flour\n…\n\nInstructions\nMix…' });
    box.append(
      h('h3', {}, 'Paste recipe text'),
      h('p', {}, 'Put the title on the first line. Headings like "Ingredients" and "Instructions" help, but aren\'t required.'),
      h('div', { class: 'field' }, ta),
      h('div', { style: { height: '14px' } }),
      h('button', { class: 'btn primary block', onclick: () => close(ta.value) }, 'Continue'));
  }).then((text) => {
    if (!text || !text.trim()) return;
    const p = parsePastedRecipe(text);
    pendingDraft = {
      title: p.title, ingredients: p.ingredients, steps: p.steps, tags: [], newPhotos: [],
      notes: p.notes ? [{ id: db.uid(), date: Date.now(), text: p.notes }] : [],
    };
    go('#/new');
  });
}

// Turn an editor/import draft into a saved recipe
async function saveDraft(d, existing) {
  const r = existing ? { ...existing } : { id: db.uid(), notes: [], photoIds: [] };
  r.title = (d.title || '').trim() || 'Untitled recipe';
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
    h('button', { class: 'icon-btn glass', 'aria-label': 'Back', onclick: () => history.length > 1 ? history.back() : go('#/') }, icon('back')),
    h('div', { class: 'right' },
      h('button', {
        class: 'icon-btn glass heart-btn' + (r.favorite ? ' on' : ''), 'aria-label': 'Favorite',
        onclick: async (e) => {
          r.favorite = !r.favorite;
          e.currentTarget.classList.toggle('on', r.favorite);
          await db.putRecipe(r); await refresh();
          toast(r.favorite ? 'Added to favorites' : 'Removed from favorites');
        },
      }, icon('heart')),
      h('button', { class: 'icon-btn glass', 'aria-label': 'Edit', onclick: () => go('#/edit/' + id) }, icon('edit'))));
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

  const facts = [
    r.yieldText || (r.servings ? `${r.servings} servings` : '') ? ['Makes', r.yieldText || `${r.servings} servings`] : null,
    r.prepTime ? ['Prep', r.prepTime] : null,
    r.cookTime ? ['Cook', r.cookTime] : null,
    r.totalTime ? ['Total', r.totalTime] : null,
  ].filter(Boolean);

  const body = h('div', { class: 'detail-body' },
    h('h1', {}, r.title),
    tagsRow(r),
    facts.length ? h('div', { class: 'facts' }, facts.map(([k, v]) => h('div', {}, k, h('b', {}, v)))) : null);

  const panel = h('div', { class: 'tab-panel' });
  const tabs = h('div', { class: 'tabs' });
  const tabDefs = [
    ['ingredients', 'Ingredients'], ['steps', 'Steps'],
    ['notes', 'Notes' + (r.notes && r.notes.length ? ` ${r.notes.length}` : '')],
    ['photos', 'Photos' + (photos.length ? ` ${photos.length}` : '')],
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
    h('button', { class: 'cook-cta', onclick: () => openCookMode(r) }, icon('flame'), 'Start cooking'));
  showTab(tab);
}

// Tags live on the recipe page: tap a tag to see everything with it,
// tap × to remove it, or "+ Tag" to add more.
function tagsRow(r) {
  const row = h('div', { class: 'tags-row editable' });
  function draw() {
    row.innerHTML = '';
    for (const t of r.tags || []) {
      row.append(h('span', { class: 'tag' },
        h('button', { class: 'tag-name', onclick: () => { homeState.tags = [t]; homeState.query = ''; homeState.fav = false; go('#/'); } }, t),
        h('button', { class: 'tag-x', 'aria-label': `Remove tag ${t}`, onclick: async () => {
          r.tags = r.tags.filter((x) => x !== t);
          await db.putRecipe(r); await refresh(); draw();
          toast(`Removed "${t}"`);
        } }, icon('x', 'sm'))));
    }
    row.append(h('button', { class: 'tag add', onclick: () => addTagsSheet(r, draw) }, icon('plus', 'sm'), (r.tags || []).length ? 'Tag' : 'Add tags'));
  }
  draw();
  return row;
}

function addTagsSheet(r, redraw) {
  openSheet((box, close) => {
    const input = h('input', { placeholder: 'Type a tag, like Autumn or Cookie', enterkeyhint: 'done', autocapitalize: 'words' });
    const current = h('div', { class: 'tags-row', style: { marginBottom: '14px' } });
    const sug = h('div', { class: 'suggest' });
    const known = allTags().map((t) => t.name);
    const has = (t) => (r.tags || []).some((x) => x.toLowerCase() === t.toLowerCase());
    async function add(raw) {
      const t = raw.trim().replace(/^#/, '');
      if (!t) return;
      const name = known.find((k) => k.toLowerCase() === t.toLowerCase()) || t;
      if (!has(name)) { r.tags = [...(r.tags || []), name]; await db.putRecipe(r); await refresh(); }
      input.value = ''; draw(); redraw(); input.focus();
    }
    function draw() {
      current.innerHTML = '';
      (r.tags || []).forEach((t) => current.append(h('span', { class: 'tag' }, t)));
      if (!(r.tags || []).length) current.append(h('span', { class: 'hint', style: { margin: 0 } }, 'No tags yet'));
      const q = input.value.trim().toLowerCase();
      sug.innerHTML = '';
      if (q && !known.some((k) => k.toLowerCase() === q) && !has(q)) {
        sug.append(h('button', { class: 'chip on', onclick: () => add(input.value) }, `+ Create "${input.value.trim()}"`));
      }
      known.filter((k) => !has(k) && (!q || k.toLowerCase().includes(q))).slice(0, 14)
        .forEach((k) => sug.append(h('button', { class: 'chip', onclick: () => add(k) }, '+ ' + k)));
    }
    input.addEventListener('input', () => { if (input.value.includes(',')) { input.value.split(',').forEach(add); return; } draw(); });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); add(input.value); } });
    box.append(h('h3', {}, 'Tags'), current, h('div', { class: 'field' }, input), sug,
      h('div', { style: { height: '16px' } }),
      h('button', { class: 'btn dark block', onclick: () => close() }, 'Done'));
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
        h('div', { class: 'scaler-label' }, 'Servings', h('b', {}, formatQty(cur))),
        h('div', { class: 'stepper' },
          h('button', { 'aria-label': 'Fewer', onclick: () => { const n = Math.max(1, Math.ceil(cur) - 1); setScale(n / r.servings); } }, '−'),
          h('span', {}, formatQty(cur)),
          h('button', { 'aria-label': 'More', onclick: () => { const n = Math.floor(cur) + 1; setScale(n / r.servings); } }, '+')));
    } else {
      top.append(h('div', { class: 'scaler-label' }, 'Scale', h('b', {}, '×' + trimNum(sc.factor))));
    }
    const mults = h('div', { class: 'mults' }, [[0.5, '½×'], [1, '1×'], [1.5, '1½×'], [2, '2×'], [3, '3×']].map(([f, l]) =>
      h('button', { class: Math.abs(sc.factor - f) < 1e-6 && !sc.note ? 'on' : '', onclick: () => setScale(f) }, l)));
    const units = h('div', { class: 'units-row' },
      h('span', {}, 'Units'),
      h('div', { class: 'seg' }, [['original', 'As written'], ['metric', 'Metric'], ['us', 'US']].map(([k, l]) =>
        h('button', { class: unitSystem === k ? 'on' : '', onclick: () => {
          unitSystem = k; localStorage.setItem('units', k);
          panel.innerHTML = ''; ingredientsPanel(panel, r);
        } }, l))));
    const scaler = h('div', { class: 'scaler' }, top, mults, units,
      sc.factor !== 1 ? h('div', { class: 'scale-note' },
        h('span', {}, sc.note ? `Adjusted to match ${sc.note} (×${trimNum(sc.factor)})` : `Scaled ×${trimNum(sc.factor)}`),
        h('button', { onclick: () => setScale(1) }, 'Reset')) : null);
    panel.append(scaler, h('p', { class: 'hint' }, 'Used a different amount by mistake? Tap "Used" on that ingredient and everything else adjusts to match.'));
  }

  const list = h('ul', { class: 'list' });
  r.ingredients.forEach((line, i) => {
    if (isSection(line)) { list.append(h('li', { class: 'sec' }, sectionName(line))); return; }
    const p = scaleIngredient(line, sc.factor, unitSystem);
    const done = checks.i.includes(i);
    const txt = h('div', { class: 'txt' }, ingredientText(p, line));
    const li = h('li', { class: 'item' + (done ? ' done' : '') },
      h('span', { class: 'check' }, icon('check')), txt,
      p.qty != null ? h('button', { class: 'amt-btn', onclick: (e) => { e.stopPropagation(); usedAmount(r, line, p, panel); } }, 'Used') : null);
    li.addEventListener('click', () => {
      const c = getChecks(r.id);
      c.i = c.i.includes(i) ? c.i.filter((x) => x !== i) : [...c.i, i];
      setChecks(r.id, c); li.classList.toggle('done');
    });
    list.append(li);
  });
  if (!r.ingredients.length) list.append(h('p', { class: 'hint' }, 'No ingredients yet. Tap the pencil to add some.'));
  panel.append(list, resetChecksBtn(r, 'i', panel, () => ingredientsPanel(panel, r)));
}

function ingredientText(p, line) {
  if (p.qty == null) return line;
  return [h('span', { class: 'qty' + (p.scaled ? ' adj' : '') }, p.amountText), p.nameText ? ' ' + p.nameText : ''];
}
const trimNum = (n) => String(Math.round(n * 100) / 100);

async function usedAmount(r, line, p, panel) {
  const val = await promptDialog({
    title: 'How much did you use?',
    message: `The recipe says ${p.display}. Enter what you actually added (like "150g" or "1 1/4 cups") and the rest of the recipe will be adjusted to keep the same proportions.`,
    value: p.amountText, ok: 'Adjust recipe',
  });
  if (val == null || !val.trim()) return;
  const factor = factorFromUsed(val, p);
  if (!factor) { toast("Couldn't read that amount. Try a number like 150g."); return; }
  scaleState.set(r.id, { factor, note: scaleIngredient(line, factor, unitSystem).display });
  panel.innerHTML = '';
  ingredientsPanel(panel, r);
  toast('Recipe adjusted');
}

function resetChecksBtn(r, key, panel, rerender) {
  return h('div', { class: 'list-actions' },
    h('button', { class: 'text-btn', onclick: () => { const c = getChecks(r.id); c[key] = []; setChecks(r.id, c); panel.innerHTML = ''; rerender(); } }, 'Clear checkmarks'));
}

function stepText(text, r, stepIndex) {
  const frag = document.createDocumentFragment();
  let last = 0;
  for (const d of findDurations(text)) {
    frag.append(text.slice(last, d.index));
    frag.append(h('button', {
      class: 'timer-chip',
      onclick: (e) => { e.stopPropagation(); startTimer({ key: `${r.id}:${stepIndex}:${d.index}`, seconds: d.seconds, label: `${r.title} · Step ${stepIndex + 1} · ${formatDurationLabel(d.seconds)}` }); },
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
  if (!r.steps.length) list.append(h('p', { class: 'hint' }, 'No steps yet. Tap the pencil to add some.'));
  panel.append(h('p', { class: 'hint' }, 'Tap a step to check it off. Tap a time to start a timer.'), list,
    resetChecksBtn(r, 's', panel, () => stepsPanel(panel, r)));
}

function notesPanel(panel, r, rerenderAll) {
  const ta = h('textarea', { rows: 3, placeholder: 'What worked, what you\'d change, who loved it…' });
  const add = h('button', { class: 'btn sm primary', onclick: async () => {
    const text = ta.value.trim(); if (!text) return;
    r.notes = [{ id: db.uid(), date: Date.now(), text }, ...(r.notes || [])];
    await db.putRecipe(r); await refresh();
    tabState.set(r.id, 'notes'); rerenderAll();
  } }, 'Add note');
  panel.append(h('div', { class: 'note-new' }, ta, h('div', { class: 'row' }, add)));
  for (const n of r.notes || []) {
    panel.append(h('button', { class: 'note', onclick: () => editNote(r, n, rerenderAll) }, h('time', {}, fmtDate(n.date)), n.text));
  }
  if (!(r.notes || []).length) panel.append(h('p', { class: 'hint' }, 'Notes are dated, so you can keep a running log each time you make it.'));
}

function editNote(r, n, rerenderAll) {
  openSheet((box, close) => {
    const ta = h('textarea', { rows: 6 }); ta.value = n.text;
    box.append(h('h3', {}, 'Edit note'), h('p', {}, fmtDate(n.date)), h('div', { class: 'field' }, ta),
      h('div', { class: 'actions', style: { display: 'flex', justifyContent: 'space-between', marginTop: '16px' } },
        h('button', { class: 'btn sm danger', onclick: () => close('delete') }, icon('trash', 'sm'), 'Delete'),
        h('button', { class: 'btn sm primary', onclick: () => close(ta.value) }, 'Save')));
  }).then(async (res) => {
    if (res === undefined) return;
    if (res === 'delete') {
      if (!(await confirmDialog({ title: 'Delete this note?', ok: 'Delete', danger: true }))) return;
      r.notes = r.notes.filter((x) => x.id !== n.id);
    } else n.text = res.trim() || n.text;
    await db.putRecipe(r); tabState.set(r.id, 'notes'); rerenderAll();
  });
}

function photosPanel(panel, r, photos, rerenderAll) {
  const grid = h('div', { class: 'photo-grid' });
  photos.forEach((p, i) => {
    grid.append(h('button', { class: 'photo-tile', onclick: () => openViewer(r, p, i, rerenderAll) },
      h('div', { class: 'ph' }, h('img', { src: p.data, alt: p.caption || '', loading: 'lazy' }), i === 0 ? h('span', { class: 'cover-badge' }, 'Cover') : null),
      p.caption ? h('div', { class: 'cap' }, p.caption) : null,
      h('div', { class: 'date' }, fmtDate(p.date))));
  });
  grid.append(h('button', { class: 'add-tile', onclick: () => addPhotos(r, rerenderAll) }, h('div', {}, icon('camera'), 'Add photos')));
  panel.append(h('p', { class: 'hint' }, 'Add photos each time you make it. Tap one to add a caption or make it the cover.'), grid);
}

async function addPhotos(r, rerenderAll) {
  const files = await pickFiles({ multiple: true });
  if (!files.length) return;
  toast('Adding photos…');
  for (const f of files) {
    const data = await resizeImage(f);
    const p = await db.putPhoto({ id: db.uid(), recipeId: r.id, data, caption: '', date: Date.now() });
    r.photoIds = [...(r.photoIds || []), p.id];
  }
  await updateThumb(r);
  await db.putRecipe(r); await refresh();
  tabState.set(r.id, 'photos'); rerenderAll();
}

function openViewer(r, p, index, rerenderAll) {
  const dateStr = (ts) => new Date(ts - new Date(ts).getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  openSheet((box, close) => {
    box.className = 'viewer';
    box.innerHTML = '';
    box.append(
      h('div', { class: 'vbar' },
        h('button', { class: 'icon-btn', 'aria-label': 'Close', onclick: () => close() }, icon('x')),
        h('span', {}, fmtDate(p.date))),
      h('img', { src: p.data, alt: '' }),
      p.caption ? h('div', { class: 'vcap' }, p.caption) : h('div', { style: { height: '12px' } }),
      h('div', { class: 'vactions' },
        h('button', { class: 'btn sm', onclick: () => close('caption') }, icon('pen', 'sm'), 'Caption & date'),
        index > 0 ? h('button', { class: 'btn sm', onclick: () => close('cover') }, icon('star', 'sm'), 'Make cover') : null,
        h('button', { class: 'btn sm', onclick: () => close('delete') }, icon('trash', 'sm'), 'Delete')));
  }).then(async (action) => {
    if (action === 'caption') {
      const res = await openSheet((box, close) => {
        const cap = h('textarea', { rows: 3, placeholder: 'Thanksgiving 2026 with Grandma…' }); cap.value = p.caption || '';
        const date = h('input', { type: 'date', value: dateStr(p.date) });
        box.append(h('h3', {}, 'Caption & date'),
          h('div', { class: 'field' }, h('label', {}, 'Caption'), cap),
          h('div', { class: 'field', style: { marginTop: '12px' } }, h('label', {}, 'Date made'), date),
          h('div', { style: { height: '16px' } }),
          h('button', { class: 'btn primary block', onclick: () => close({ caption: cap.value.trim(), date: date.value }) }, 'Save'));
      });
      if (!res) return;
      p.caption = res.caption;
      if (res.date) p.date = new Date(res.date + 'T12:00:00').getTime();
      await db.putPhoto(p);
    } else if (action === 'cover') {
      r.photoIds = [p.id, ...r.photoIds.filter((x) => x !== p.id)];
      await updateThumb(r); await db.putRecipe(r); await refresh();
      toast('Cover photo updated');
    } else if (action === 'delete') {
      if (!(await confirmDialog({ title: 'Delete this photo?', ok: 'Delete', danger: true }))) return;
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
  let idx = Math.max(0, steps.findIndex((s) => !checks.s.includes(s.i)));
  if (idx === -1 || checks.s.length >= steps.length) idx = 0;
  const sc = getScale(r.id);

  const root = h('div', { class: 'cook' });
  let ingOpen = null;
  history.pushState({ cook: true }, '');
  const onPop = () => { if (ingOpen) { ingOpen.remove(); ingOpen = null; return; } exit(true); };
  window.addEventListener('popstate', onPop);
  function exit(fromPop) {
    window.removeEventListener('popstate', onPop);
    keepAwake(false); root.remove();
    if (!fromPop) history.back();
    if (location.hash.startsWith('#/r/')) renderDetail(r.id);
  }

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
    history.pushState({ cookIng: true }, '');
    ingOpen = h('div', { class: 'cook-ings' },
      h('div', { class: 'cook-head' },
        h('div', { class: 't' }, h('small', {}, sc.factor !== 1 ? `Scaled ×${trimNum(sc.factor)}` : 'Tap to check off'), h('b', {}, 'Ingredients')),
        h('button', { class: 'icon-btn', 'aria-label': 'Close', onclick: () => history.back() }, icon('x'))),
      list);
    root.append(ingOpen);
  }

  function draw() {
    const c = getChecks(r.id);
    progress.innerHTML = '';
    steps.forEach((s, i) => progress.append(h('span', { class: i === idx ? 'on' : c.s.includes(s.i) ? 'done' : '' })));
    bodyEl.innerHTML = '';
    nav.innerHTML = '';
    if (idx >= steps.length) {
      bodyEl.append(h('div', { class: 'cook-done-msg' },
        h('h2', {}, 'All done!'),
        h('p', { style: { color: 'var(--muted)', margin: '0 0 22px' } }, 'Enjoy it. Want to remember how it went?'),
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px', alignItems: 'center' } },
          h('button', { class: 'btn primary', onclick: async () => { exit(false); tabState.set(r.id, 'photos'); setTimeout(() => addPhotos(r, () => renderDetail(r.id)), 300); } }, icon('camera'), 'Add a photo'),
          h('button', { class: 'btn', onclick: () => { tabState.set(r.id, 'notes'); exit(false); } }, icon('note'), 'Write a note'))));
      nav.append(
        h('button', { class: 'btn prev', 'aria-label': 'Previous', onclick: () => { idx--; draw(); } }, icon('back')),
        h('button', { class: 'btn dark', onclick: () => exit(false) }, 'Finish'));
      return;
    }
    const st = steps[idx];
    bodyEl.append(
      h('div', { class: 'cook-step-label' }, `Step ${idx + 1} of ${steps.length}`),
      st.section ? h('div', { class: 'cook-sec' }, st.section) : null,
      h('div', { class: 'cook-text' }, stepText(st.text, r, st.num - 1)));
    nav.append(
      h('button', { class: 'btn prev', 'aria-label': 'Previous', disabled: idx === 0, onclick: () => { idx--; draw(); } }, icon('back')),
      h('button', { class: 'btn primary', onclick: () => {
        const cc = getChecks(r.id); if (!cc.s.includes(st.i)) cc.s.push(st.i); setChecks(r.id, cc);
        idx++; draw();
      } }, idx === steps.length - 1 ? 'Done' : 'Next step'));
  }

  root.append(
    h('div', { class: 'cook-head' },
      h('button', { class: 'icon-btn', 'aria-label': 'Exit cook mode', onclick: () => exit(false) }, icon('x')),
      h('div', { class: 't' }, h('small', {}, 'Cook mode'), h('b', {}, r.title)),
      h('button', { class: 'btn sm', onclick: showIngredients }, icon('list', 'sm'), 'Ingredients')),
    progress, bodyEl, nav);
  if (!steps.length) { toast('This recipe has no steps yet'); }
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

  const s = screen();
  const title = h('input', { class: 'title-input', placeholder: 'Recipe name', value: d.title || '' });

  // photos
  const strip = h('div', { class: 'photo-strip' });
  function drawPhotos() {
    strip.innerHTML = '';
    const items = [...d.photos.map((p) => ({ kind: 'old', p, src: p.data })), ...d.newPhotos.map((data, i) => ({ kind: 'new', i, src: data }))];
    items.forEach((it, n) => strip.append(h('div', { class: 'p' }, h('img', { src: it.src, alt: '' }),
      n === 0 ? h('span', { class: 'cv' }, 'Cover') : null,
      h('button', { class: 'rm', 'aria-label': 'Remove photo', onclick: () => {
        if (it.kind === 'old') { d.removedPhotos.push(it.p.id); d.photos = d.photos.filter((x) => x !== it.p); }
        else d.newPhotos.splice(it.i, 1);
        drawPhotos();
      } }, icon('x')))));
    strip.append(h('button', { class: 'add', 'aria-label': 'Add photos', onclick: async () => {
      const files = await pickFiles({ multiple: true });
      for (const f of files) d.newPhotos.push(await resizeImage(f));
      drawPhotos();
    } }, icon('camera')));
  }
  drawPhotos();

  // tags
  let tags = [...(d.tags || [])];
  const tagInput = h('input', { placeholder: tags.length ? 'Add tag' : 'Autumn, Cookies, Halloween…', enterkeyhint: 'done', autocapitalize: 'words' });
  const tagBox = h('div', { class: 'tag-input', onclick: () => tagInput.focus() });
  const suggest = h('div', { class: 'suggest' });
  const known = allTags().map((t) => t.name);
  function addTag(raw) {
    const t = raw.trim().replace(/^#/, '');
    if (!t) return;
    const match = known.find((k) => k.toLowerCase() === t.toLowerCase()) || t;
    if (!tags.some((x) => x.toLowerCase() === match.toLowerCase())) tags.push(match);
    tagInput.value = '';
    drawTags();
  }
  function drawTags() {
    tagBox.innerHTML = '';
    for (const t of tags) tagBox.append(h('button', { class: 'chip', type: 'button', onclick: (e) => { e.stopPropagation(); tags = tags.filter((x) => x !== t); drawTags(); } }, t, h('span', { class: 'x' }, icon('x', 'sm'))));
    tagBox.append(tagInput);
    const q = tagInput.value.trim().toLowerCase();
    const pool = [...new Set([...(d.suggestedTags || []), ...known])];
    const sug = pool.filter((k) => !tags.some((x) => x.toLowerCase() === k.toLowerCase()) && (!q || k.toLowerCase().includes(q))).slice(0, 10);
    suggest.innerHTML = '';
    sug.forEach((k) => suggest.append(h('button', { class: 'chip', type: 'button', onclick: () => { addTag(k); tagInput.focus(); } }, '+ ' + k)));
    if (q && !pool.some((k) => k.toLowerCase() === q)) suggest.prepend(h('button', { class: 'chip on', type: 'button', onclick: () => { addTag(tagInput.value); tagInput.focus(); } }, `+ Create "${tagInput.value.trim()}"`));
  }
  tagInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addTag(tagInput.value); }
    if (e.key === 'Backspace' && !tagInput.value && tags.length) { tags.pop(); drawTags(); tagInput.focus(); }
  });
  tagInput.addEventListener('input', () => {
    if (tagInput.value.includes(',')) { tagInput.value.split(',').forEach(addTag); tagInput.focus(); return; }
    const pos = tagInput.value; drawTags(); tagInput.value = pos; tagInput.focus();
  });
  drawTags();

  const servings = h('input', { type: 'number', inputmode: 'numeric', min: 1, placeholder: '4', value: d.servings || '' });
  const yieldText = h('input', { placeholder: 'e.g. 12 donuts', value: d.yieldText || '' });
  const prep = h('input', { placeholder: '15 min', value: d.prepTime || '' });
  const cook = h('input', { placeholder: '25 min', value: d.cookTime || '' });
  const total = h('input', { placeholder: '40 min', value: d.totalTime || '' });
  const ings = h('textarea', { class: 'big', placeholder: '2 cups flour\n140g sugar\n# Glaze\n1 cup powdered sugar' });
  ings.value = (d.ingredients || []).join('\n');
  const steps = h('textarea', { class: 'big', placeholder: 'Preheat the oven to 350°F.\nWhisk the dry ingredients.\nBake for 25 minutes.' });
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
    toast(existing ? 'Saved' : 'Recipe added');
    if (existing) history.back();
    else location.replace('#/r/' + r.id);
  }
  const saveBtn = h('button', { class: 'btn primary sm', onclick: save }, 'Save');

  const field = (label, el, help) => h('div', { class: 'field' }, h('label', {}, label), el, help ? h('div', { class: 'help' }, help) : null);

  s.append(
    h('div', { class: 'bar' },
      h('button', { class: 'icon-btn', 'aria-label': 'Cancel', onclick: async () => {
        if (await confirmDialog({ title: 'Discard changes?', ok: 'Discard', cancel: 'Keep editing', danger: true })) history.back();
      } }, icon('x')),
      h('h2', {}, existing ? 'Edit recipe' : 'New recipe'), saveBtn),
    h('div', { class: 'form' },
      d.suggestedTags ? h('p', { class: 'hint', style: { margin: 0 } }, 'Imported! Look it over, add your tags, then save.') : null,
      field('Name', title),
      field('Photos', strip, 'The first photo is the cover. Add as many as you like.'),
      h('div', { class: 'field' }, h('label', {}, 'Tags'), tagBox, suggest),
      h('div', { class: 'row2' }, field('Servings', servings), field('Makes (optional)', yieldText)),
      h('div', { class: 'row3' }, field('Prep', prep), field('Cook', cook), field('Total', total)),
      field('Ingredients', ings, 'One per line. Start a line with # to make a heading, like "# Frosting".'),
      field('Steps', steps, 'One step per line. Times like "25 minutes" become tappable timers.'),
      existing ? h('button', { class: 'btn danger block', onclick: async () => {
        if (!(await confirmDialog({ title: 'Delete this recipe?', message: 'Its photos and notes will be deleted too. This can\'t be undone.', ok: 'Delete', danger: true }))) return;
        await db.deleteRecipe(existing.id); localStorage.removeItem('checks:' + existing.id);
        await refresh(); toast('Recipe deleted'); location.replace('#/'); history.replaceState(null, '', '#/');
      } }, icon('trash', 'sm'), 'Delete recipe') : null,
    ));
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
  const seg = h('div', { class: 'seg' }, [['system', 'Auto'], ['light', 'Light'], ['dark', 'Dark']].map(([k, l]) =>
    h('button', { class: k === pref ? 'on' : '', onclick: () => { localStorage.setItem('theme', k); applyTheme(); renderSettings(); } }, l)));

  s.append(
    h('div', { class: 'bar' },
      h('button', { class: 'icon-btn', 'aria-label': 'Back', onclick: () => history.back() }, icon('back')),
      h('h2', {}, 'Settings')),
    h('div', { class: 'form' },
      h('div', {}, h('div', { class: 'group-title' }, 'Appearance'),
        h('div', { class: 'group' }, h('div', { class: 'row-item' }, h('div', {}, 'Theme', h('small', {}, 'Auto follows your phone')), seg))),
      h('div', {}, h('div', { class: 'group-title' }, 'Backup'),
        h('div', { class: 'group' },
          h('button', { class: 'row-item', onclick: exportBackup }, h('div', {}, 'Save a backup', h('small', {}, `All ${countLabel(recipes.length)}, with photos and notes`)), icon('download')),
          h('button', { class: 'row-item', onclick: importBackup }, h('div', {}, 'Restore from backup', h('small', {}, 'Use this on a new phone')), icon('upload'))),
        h('p', { class: 'hint', style: { margin: '8px 4px 0' } }, 'Recipes live only on this phone. Save a backup now and then to Google Drive or your computer.')),
    ));
}

async function exportBackup() {
  toast('Preparing backup…');
  const data = { app: '300-recipes', version: 1, exported: new Date().toISOString(), recipes: await db.allRecipes(), photos: await db.allPhotos() };
  const name = `300-recipes-backup-${new Date().toISOString().slice(0, 10)}.json`;
  try { await saveFile(name, JSON.stringify(data)); } catch (e) { toast('Backup was not saved'); }
}

async function importBackup() {
  const [file] = await pickFiles({ accept: '.json,application/json,text/plain,*/*', multiple: false });
  if (!file) return;
  let data;
  try { data = JSON.parse(await file.text()); } catch { toast("That file isn't a 300 Recipes backup"); return; }
  if (!data || !['300-recipes', 'recipe-box'].includes(data.app) || !Array.isArray(data.recipes)) { toast("That file isn't a 300 Recipes backup"); return; }
  const ok = await confirmDialog({
    title: `Restore ${countLabel(data.recipes.length)}?`,
    message: 'They\'ll be added to this phone. If a recipe from the backup is already here, the backup\'s version replaces it.',
    ok: 'Restore',
  });
  if (!ok) return;
  await db.importAll(data.recipes, data.photos || []);
  await refresh();
  toast(`Restored ${countLabel(data.recipes.length)}`);
  renderSettings();
}

// =====================================================================
// START
// =====================================================================

window.addEventListener('hashchange', route);
(async function start() {
  applyTheme();
  await refresh();
  initTimers();
  route();
})();
