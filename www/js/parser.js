// Pure helpers: ingredient scaling, timer detection, recipe import parsing.
// No DOM access here, so this file can be tested outside the app.

const UNICODE_FRACTIONS = {
  '½': 0.5, '⅓': 1 / 3, '⅔': 2 / 3, '¼': 0.25, '¾': 0.75, '⅕': 0.2, '⅖': 0.4,
  '⅗': 0.6, '⅘': 0.8, '⅙': 1 / 6, '⅚': 5 / 6, '⅛': 0.125, '⅜': 0.375, '⅝': 0.625, '⅞': 0.875,
};
const UF = Object.keys(UNICODE_FRACTIONS).join('');

// Language for unit names and durations ('en' or 'es')
let parserLang = 'en';
export function setParserLang(l) { parserLang = l === 'es' ? 'es' : 'en'; }

// One quantity: "1 1/2", "1½", "1 ½", "3/4", "½", "2.5", "2,5", "150"
const QTY = `(?:\\d+\\s+\\d+\\/\\d+|\\d+\\/\\d+|\\d+\\s*[${UF}]|[${UF}]|\\d+(?:[.,]\\d+)?)`;
const QTY_RE = new RegExp(`^(\\s*)(${QTY})(?:(\\s*(?:-|–|—|to)\\s*)(${QTY}))?`, 'i');

const METRIC_UNIT_RE = /^\s*(g|gr|grams?|kg|kilograms?|mg|ml|millilit(?:er|re)s?|l|lit(?:er|re)s?|cl|dl)\b/i;

export function parseQty(str) {
  if (!str) return null;
  let s = str.trim().replace(',', '.');
  let total = 0;
  const uni = s.match(new RegExp(`[${UF}]`));
  if (uni) {
    total += UNICODE_FRACTIONS[uni[0]];
    s = s.replace(uni[0], '').trim();
  }
  if (!s) return total;
  const parts = s.split(/\s+/);
  for (const p of parts) {
    if (p.includes('/')) {
      const [a, b] = p.split('/').map(Number);
      if (!b) return null;
      total += a / b;
    } else {
      const n = Number(p);
      if (Number.isNaN(n)) return null;
      total += n;
    }
  }
  return total;
}

const NICE_FRACTIONS = [
  [0, ''], [1 / 8, '⅛'], [1 / 4, '¼'], [1 / 3, '⅓'], [3 / 8, '⅜'], [1 / 2, '½'],
  [5 / 8, '⅝'], [2 / 3, '⅔'], [3 / 4, '¾'], [7 / 8, '⅞'], [1, ''],
];

export function formatQty(n, metric = false) {
  if (n == null || !isFinite(n)) return '';
  if (metric) {
    if (n >= 10) return String(Math.round(n));
    return String(Math.round(n * 10) / 10);
  }
  let whole = Math.floor(n);
  const frac = n - whole;
  let best = NICE_FRACTIONS[0];
  for (const f of NICE_FRACTIONS) if (Math.abs(f[0] - frac) < Math.abs(best[0] - frac)) best = f;
  if (best[0] === 1) { whole += 1; best = NICE_FRACTIONS[0]; }
  // Very small amounts that would round to zero: show a decimal instead
  if (whole === 0 && best[1] === '') return String(Math.round(n * 100) / 100);
  if (whole === 0) return best[1];
  return best[1] ? `${whole} ${best[1]}` : String(whole);
}

// ---------- Units & conversion ----------

const UNITS = {
  tsp: { dim: 'v', f: 4.929, one: 'tsp', many: 'tsp', es: ['cdta.', 'cdtas.'], sys: 'spoon' },
  tbsp: { dim: 'v', f: 14.787, one: 'tbsp', many: 'tbsp', es: ['cda.', 'cdas.'], sys: 'spoon' },
  cup: { dim: 'v', f: 236.59, one: 'cup', many: 'cups', es: ['taza', 'tazas'], sys: 'us' },
  floz: { dim: 'v', f: 29.574, one: 'fl oz', many: 'fl oz', es: ['oz líq.', 'oz líq.'], sys: 'us' },
  pint: { dim: 'v', f: 473.18, one: 'pint', many: 'pints', es: ['pinta', 'pintas'], sys: 'us' },
  quart: { dim: 'v', f: 946.35, one: 'quart', many: 'quarts', es: ['cuarto', 'cuartos'], sys: 'us' },
  gallon: { dim: 'v', f: 3785.4, one: 'gallon', many: 'gallons', es: ['galón', 'galones'], sys: 'us' },
  ml: { dim: 'v', f: 1, one: 'ml', many: 'ml', sys: 'metric' },
  cl: { dim: 'v', f: 10, one: 'cl', many: 'cl', sys: 'metric' },
  dl: { dim: 'v', f: 100, one: 'dl', many: 'dl', sys: 'metric' },
  l: { dim: 'v', f: 1000, one: 'L', many: 'L', sys: 'metric' },
  g: { dim: 'w', f: 1, one: 'g', many: 'g', sys: 'metric' },
  kg: { dim: 'w', f: 1000, one: 'kg', many: 'kg', sys: 'metric' },
  mg: { dim: 'w', f: 0.001, one: 'mg', many: 'mg', sys: 'metric' },
  oz: { dim: 'w', f: 28.3495, one: 'oz', many: 'oz', sys: 'us' },
  lb: { dim: 'w', f: 453.59, one: 'lb', many: 'lb', sys: 'us' },
  stick: { dim: 'w', f: 113.4, one: 'stick', many: 'sticks', es: ['barra', 'barras'], sys: 'us' },
};

const UNIT_RE = /^\s*(tazas?|cucharaditas?|cucharadas?|cdtas?\.?|cditas?\.?|cdas?\.?|gramos?|kilogramos?|kilos?|mililitros?|litros?|onzas?|libras?|fl\.?\s*oz\.?|fluid\s+ounces?|tablespoons?|tbsps?\.?|tbs\.?|tbl\.?|teaspoons?|tsps?\.?|cups?|c\.?|ounces?|oz\.?|pounds?|lbs?\.?|grams?|gr?\.?|kilograms?|kgs?\.?|milligrams?|mg|millilit(?:er|re)s?|mls?|centilit(?:er|re)s?|cl|decilit(?:er|re)s?|dl|lit(?:er|re)s?|l|pints?|pt\.?|quarts?|qts?\.?|gallons?|gal\.?|sticks?|T|t)(?![a-záéíóúñ])/i;

function unitKey(tok) {
  const t = tok.replace(/\./g, '').replace(/\s+/g, ' ').trim();
  if (t === 'T') return 'tbsp';
  if (t === 't') return 'tsp';
  const l = t.toLowerCase();
  if (/^(fl oz|floz|fluid ounces?)$/.test(l)) return 'floz';
  if (/^(tablespoons?|tbsps?|tbs|tbl)$/.test(l)) return 'tbsp';
  if (/^(teaspoons?|tsps?)$/.test(l)) return 'tsp';
  if (/^(cups?|c)$/.test(l)) return 'cup';
  if (/^(ounces?|oz)$/.test(l)) return 'oz';
  if (/^(pounds?|lbs?)$/.test(l)) return 'lb';
  if (/^(grams?|gr?)$/.test(l)) return 'g';
  if (/^(kilograms?|kgs?)$/.test(l)) return 'kg';
  if (/^(milligrams?|mg)$/.test(l)) return 'mg';
  if (/^(millilit(er|re)s?|mls?)$/.test(l)) return 'ml';
  if (/^(centilit(er|re)s?|cl)$/.test(l)) return 'cl';
  if (/^(decilit(er|re)s?|dl)$/.test(l)) return 'dl';
  if (/^(lit(er|re)s?|l)$/.test(l)) return 'l';
  if (/^(pints?|pt)$/.test(l)) return 'pint';
  if (/^(quarts?|qts?)$/.test(l)) return 'quart';
  if (/^(gallons?|gal)$/.test(l)) return 'gallon';
  if (/^sticks?$/.test(l)) return 'stick';
  // Spanish
  if (/^tazas?$/.test(l)) return 'cup';
  if (/^(cucharaditas?|cdtas?|cditas?)$/.test(l)) return 'tsp';
  if (/^(cucharadas?|cdas?)$/.test(l)) return 'tbsp';
  if (/^gramos?$/.test(l)) return 'g';
  if (/^(kilogramos?|kilos?)$/.test(l)) return 'kg';
  if (/^mililitros?$/.test(l)) return 'ml';
  if (/^litros?$/.test(l)) return 'l';
  if (/^onzas?$/.test(l)) return 'oz';
  if (/^libras?$/.test(l)) return 'lb';
  return null;
}

// Grams per millilitre for common baking & cooking ingredients (most specific first)
const DENSITIES = [
  [/bread flour|harina (?:de|para) pan/, 0.537], [/cake flour|pastry flour|harina para pastel/, 0.482],
  [/almond flour|almond meal|harina de almendras?/, 0.406], [/whole wheat flour|harina integral/, 0.507],
  [/coconut flour|harina de coco/, 0.473], [/rye flour|harina de centeno/, 0.432], [/flour|harina/, 0.507],
  [/brown sugar|az[uú]car morena|mascabado/, 0.9],
  [/powdered sugar|confectioners|icing sugar|az[uú]car glass?|az[uú]car pulverizada|az[uú]car impalpable/, 0.507],
  [/coconut sugar|az[uú]car de coco/, 0.634], [/sugar|az[uú]car/, 0.845],
  [/cocoa|cacao/, 0.355], [/cornstarch|corn starch|cornflour|maicena|f[eé]cula de ma[ií]z/, 0.473],
  [/baking soda|bicarbonate|bicarbonato/, 1.22], [/baking powder|polvo (?:para|de) hornear/, 0.81],
  [/kosher salt|sal kosher/, 0.6], [/salt|\bsal\b/, 1.22], [/yeast|levadura/, 0.6],
  [/cinnamon|spice|nutmeg|ginger|cloves|allspice|paprika|cumin|canela|nuez moscada|jengibre|clavo|comino|piment[oó]n/, 0.5],
  [/peanut butter|almond butter|crema de cacahuate|mantequilla de cacahuate|mantequilla de man[ií]/, 1.14],
  [/butter|mantequilla|margarina/, 0.959], [/shortening|manteca/, 0.81], [/oil|aceite/, 0.92, true],
  [/honey|miel de abeja/, 1.42], [/molasses|melaza/, 1.42], [/maple syrup|corn syrup|syrup|jarabe|miel de maple/, 1.33], [/miel/, 1.42],
  [/cream cheese|queso crema/, 0.96], [/sour cream|crema [aá]cida/, 0.97],
  [/heavy cream|whipping cream|double cream|half and half|cream|crema/, 1.0, true],
  [/yogurt|yoghurt|yogur/, 1.03], [/condensed milk|leche condensada/, 1.3, true], [/buttermilk|milk|leche/, 1.03, true],
  [/water|broth|stock|juice|coffee|wine|vinegar|agua|caldo|jugo|caf[eé]|vino|vinagre|consom[eé]/, 1.0, true],
  [/pumpkin|calabaza/, 0.96], [/applesauce|pur[eé] de manzana/, 1.05], [/mashed banana|banana|pl[aá]tano/, 0.95],
  [/rolled oats|oats|avena/, 0.38], [/rice|arroz/, 0.78], [/chocolate chips|chips|chispas/, 0.72],
  [/shredded coconut|coconut|coco rallado|\bcoco\b/, 0.36], [/raisins|cranberries|pasas|ar[aá]ndanos/, 0.63],
  [/walnuts|pecans|nuts|almonds|nuez|nueces|almendras|cacahuates?/, 0.48],
  [/shredded cheese|grated cheese|parmesan|cheese|queso/, 0.42],
  [/breadcrumbs|bread crumbs|panko|pan molido/, 0.25], [/vanilla|extract|vainilla|extracto/, 0.88, true],
];
export function densityFor(name) {
  const n = String(name || '').toLowerCase();
  for (const [re, d] of DENSITIES) if (re.test(n)) return d;
  return null;
}
// Liquids are shown in ml rather than grams in metric mode
function isLiquid(name) {
  const n = String(name || '').toLowerCase();
  for (const [re, , liquid] of DENSITIES) if (re.test(n)) return !!liquid;
  return false;
}

function fmtMetric(amount, dim) {
  if (dim === 'w' && amount >= 1000) return `${Math.round(amount / 100) / 10} kg`;
  if (dim === 'v' && amount >= 1000) return `${Math.round(amount / 100) / 10} L`;
  return `${formatQty(amount, true)} ${dim === 'w' ? 'g' : 'ml'}`;
}

function pickUsVolume(ml) {
  if (ml >= 236.59 * 0.24) return 'cup';
  if (ml >= 14.787 * 0.99) return 'tbsp';
  return 'tsp';
}

// plural based on what is shown, so 1.05 cups (shown as "1") reads "1 cup"
function unitLabel(key, n, lang = parserLang) {
  const u = UNITS[key];
  const many = parseQty(formatQty(n, u.sys === 'metric')) > 1;
  if (lang === 'es' && u.es) return u.es[many ? 1 : 0];
  return many ? u.many : u.one;
}

// Is this ingredient line written in Spanish or English? (for unit names)
const ES_UNIT = /^\s*(tazas?|cucharaditas?|cucharadas?|cdtas?|cditas?|cdas?|gramos?|kilogramos?|kilos?|mililitros?|litros?|onzas?|libras?)\b/i;
const EN_UNIT = /^\s*(cups?|tablespoons?|teaspoons?|tbsps?|tsps?|ounces?|pounds?|lbs?|grams?|sticks?)\b/i;
function lineLang(p) {
  if (ES_UNIT.test(p.unitText || '') || /^\s*de\s/i.test(p.name || '')) return 'es';
  if (EN_UNIT.test(p.unitText || '')) return 'en';
  return parserLang;
}

// Convert an amount (in ml or g) into the chosen system.
// Returns { n, key } or { text } for metric output.
function convertAmount(canon, dim, system, density, liquid) {
  if (system === 'metric') {
    if (dim === 'v' && density && !liquid) return { n: canon * density, dim: 'w' };
    return { n: canon, dim };
  }
  // US
  if (dim === 'w' && density) { const ml = canon / density; const key = pickUsVolume(ml); return { n: ml / UNITS[key].f, key }; }
  if (dim === 'w') { const oz = canon / UNITS.oz.f; return oz >= 16 ? { n: oz / 16, key: 'lb' } : { n: oz, key: 'oz' }; }
  const key = pickUsVolume(canon);
  return { n: canon / UNITS[key].f, key };
}

// Split an ingredient line into amount, unit and name.
export function parseIngredient(line) {
  const text = String(line || '');
  if (isSection(text)) return { section: true, text: sectionName(text) };
  const m = text.match(QTY_RE);
  if (!m) return { qty: null, text, rest: text, name: text };
  const qty = parseQty(m[2]);
  const qty2 = m[4] ? parseQty(m[4]) : null;
  const rest = text.slice(m[0].length);
  let unit = null, unitText = '', name = rest, alt = null;
  const um = rest.match(UNIT_RE);
  if (um) {
    unit = unitKey(um[1]);
    if (unit) { unitText = um[0]; name = rest.slice(um[0].length); }
  }
  // "1 cup (120g) flour" → remember the 120g as an exact equivalent
  if (unit) {
    const pm = name.match(/^\s*\(\s*([^)]*?)\s*\)/);
    if (pm) {
      const inner = pm[1].match(QTY_RE);
      if (inner) {
        const iu = pm[1].slice(inner[0].length).match(UNIT_RE);
        const ik = iu && unitKey(iu[1]);
        if (ik) { alt = { qty: parseQty(inner[2]), unit: ik, raw: pm[0] }; }
      }
    }
  }
  name = name.replace(/^\s*\.\s*/, ' ');
  const metric = unit ? UNITS[unit].sys === 'metric' : false;
  return { qty, qty2, rangeSep: m[3] || '', rest, metric, text, unit, unitText, name, alt };
}

function cleanName(name) {
  return name.replace(/^\s*(of\s+)?/i, '').trim();
}

// Produce the text to show for an ingredient at a given scale and unit system
// ('original' | 'metric' | 'us'). Also returns what "Used" needs to work.
export function scaleIngredient(line, factor = 1, system = 'original') {
  const p = parseIngredient(line);
  if (p.section || p.qty == null) return { ...p, display: p.text, scaled: false };
  const u = p.unit ? UNITS[p.unit] : null;
  const density = densityFor(p.name);
  const ll = lineLang(p);
  const base = { ...p, density };

  const needsConvert = u && system !== 'original' && u.sys !== 'spoon' &&
    ((system === 'metric' && u.sys === 'us') || (system === 'us' && u.sys === 'metric'));

  if (!needsConvert) {
    // Same units as written; just scale the numbers
    const dim = u ? u.dim : 'n';
    const per = u ? u.f : 1;
    let amountText, name = p.name;
    if (factor === 1) {
      amountText = p.text.slice(0, p.text.length - p.name.length).trim();
    } else {
      amountText = formatQty(p.qty * factor, p.metric);
      if (p.qty2 != null) amountText += ' – ' + formatQty(p.qty2 * factor, p.metric);
      if (u) {
        let ut = p.unitText.trim();
        // fix plurals for spelled-out units: "1 cup" → "2 cups"
        const n = (p.qty2 ?? p.qty) * factor;
        if (/^[a-z]{3,}s?$/i.test(ut) && !/^(oz|lbs?|tbsps?|tsps?)$/i.test(ut)) ut = ut.replace(/s$/i, '') + (parseQty(formatQty(n, p.metric)) > 1 ? 's' : '');
        amountText += (/^\s/.test(p.unitText) ? ' ' : '') + ut;
      }
      // scale an equivalent written in brackets too: "1 cup (120g)" → "2 cups (240g)"
      if (p.alt && UNITS[p.alt.unit].dim) {
        const au = UNITS[p.alt.unit];
        const altText = `(${formatQty(p.alt.qty * factor, au.sys === 'metric')}${au.sys === 'metric' ? '' : ' '}${unitLabel(p.alt.unit, p.alt.qty * factor, ll)})`;
        name = name.replace(p.alt.raw, ' ' + altText);
      }
    }
    return {
      ...base, amountText, nameText: cleanName(name).length ? name.trim() : '',
      display: (amountText + ' ' + name.trim()).trim(), scaled: factor !== 1,
      dim, canonBase: p.qty * per, canonPerDisp: per,
    };
  }

  // Convert to the other system
  let name = p.name;
  let canon, dim;
  const targetSys = system === 'metric' ? 'metric' : 'us';
  if (p.alt && UNITS[p.alt.unit].sys === targetSys) {
    canon = p.alt.qty * UNITS[p.alt.unit].f; dim = UNITS[p.alt.unit].dim;
  } else { canon = p.qty * u.f; dim = u.dim; }
  if (p.alt) name = name.replace(p.alt.raw, '');
  const ratio = p.qty2 != null ? p.qty2 / p.qty : null;

  const out = convertAmount(canon * factor, dim, system, density, isLiquid(p.name));
  let amountText, dispDim, canonPerDisp;
  if (system === 'metric') {
    dispDim = out.dim;
    amountText = fmtMetric(out.n, out.dim);
    if (ratio) amountText = fmtMetric(out.n, out.dim).replace(/^[\d.]+/, (a) => `${a} – ${formatQty(out.n * ratio, true)}`);
    canonPerDisp = 1;
  } else {
    dispDim = 'v';
    if (out.key === 'oz' || out.key === 'lb') dispDim = 'w';
    amountText = `${formatQty(out.n)} ${unitLabel(out.key, out.n, ll)}`;
    if (ratio) amountText = `${formatQty(out.n)} – ${formatQty(out.n * ratio)} ${unitLabel(out.key, out.n * ratio, ll)}`;
    canonPerDisp = UNITS[out.key].f;
  }
  // canonical amount at scale 1, in the dimension being displayed
  let canonBase = canon;
  if (dispDim !== dim && density) canonBase = dim === 'v' ? canon * density : canon / density;
  name = name.replace(/^\s*\.\s*/, ' ').trim();
  return {
    ...base, amountText, nameText: name, display: `${amountText} ${name}`.trim(),
    scaled: true, converted: true, dim: dispDim, canonBase, canonPerDisp,
  };
}

// The person typed what they actually used ("150g", "2/3", "1 cup").
// Work out the new scale factor for the whole recipe.
export function factorFromUsed(input, info) {
  const p = parseIngredient(String(input || '').trim());
  if (p.qty == null || !info || !info.canonBase) return null;
  let canon;
  if (p.unit) {
    const u = UNITS[p.unit];
    canon = p.qty * u.f;
    if (u.dim !== info.dim) {
      if (!info.density || info.dim === 'n') return null;
      canon = u.dim === 'v' ? canon * info.density : canon / info.density;
    }
  } else {
    canon = p.qty * (info.canonPerDisp || 1);
  }
  const f = canon / info.canonBase;
  return isFinite(f) && f > 0 ? f : null;
}

export function isSection(line) {
  return /^\s*#/.test(line || '');
}
export function sectionName(line) {
  return String(line).replace(/^\s*#+\s*/, '').trim();
}

// ---------- Timers ----------

const DUR_RE = /(\d+(?:[.,]\d+)?|an?|one|half an?|una?|media)\s*(?:(?:-|–|to|a)\s*(\d+(?:[.,]\d+)?)\s*)?(hours?|hrs?|horas?|minutes?|minutos?|mins?|seconds?|segundos?|secs?|segs?)\b(?:\s*(?:(?:and|y)\s*)?(\d+)\s*(minutes?|minutos?|mins?))?/gi;

function wordNum(w) {
  const s = w.toLowerCase().replace(',', '.');
  if (s === 'a' || s === 'an' || s === 'one' || s === 'un' || s === 'una') return 1;
  if (s.startsWith('half') || s === 'media') return 0.5;
  return Number(s);
}

export function findDurations(text) {
  const out = [];
  if (!text) return out;
  DUR_RE.lastIndex = 0;
  let m;
  while ((m = DUR_RE.exec(text))) {
    const n = wordNum(m[1]);
    if (!isFinite(n) || n <= 0) continue;
    const unit = m[3].toLowerCase();
    let mult = unit.startsWith('h') ? 3600 : unit.startsWith('s') ? 1 : 60;
    let seconds = n * mult;
    if (m[4]) seconds += Number(m[4]) * 60;
    if (seconds < 5 || seconds > 48 * 3600) continue;
    out.push({ index: m.index, length: m[0].length, match: m[0], seconds: Math.round(seconds) });
  }
  return out;
}

export function formatClock(sec) {
  sec = Math.max(0, Math.ceil(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  const pad = (x) => String(x).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

export function formatDurationLabel(sec) {
  const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
  const hr = parserLang === 'es' ? 'h' : 'hr';
  if (h && m) return `${h} ${hr} ${m} min`;
  if (h) return `${h} ${hr}`;
  if (m) return `${m} min`;
  return `${sec} ${parserLang === 'es' ? 's' : 'sec'}`;
}

// ---------- Import from website HTML ----------

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', deg: '°', frac12: '½', frac14: '¼', frac34: '¾', ndash: '–', mdash: '—', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', hellip: '…', eacute: 'é', egrave: 'è', ntilde: 'ñ', uuml: 'ü', ouml: 'ö', auml: 'ä', reg: '®', trade: '™', times: '×', frasl: '⁄' };

export function cleanText(s) {
  if (s == null) return '';
  let t = String(s);
  for (let i = 0; i < 2; i++) { // some sites double-encode
    t = t.replace(/&(#x?[0-9a-f]+|[a-z0-9]+);/gi, (all, code) => {
      if (code[0] === '#') {
        const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
        return isFinite(n) ? String.fromCodePoint(n) : all;
      }
      return ENTITIES[code.toLowerCase()] ?? all;
    });
  }
  return t.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').replace(/[ \t ]+/g, ' ').trim();
}

function asArray(x) { return x == null ? [] : Array.isArray(x) ? x : [x]; }

function hasType(obj, type) {
  return asArray(obj && obj['@type']).some((t) => String(t).toLowerCase() === type.toLowerCase());
}

function findRecipeNode(node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 8) return null;
  if (Array.isArray(node)) {
    for (const n of node) { const r = findRecipeNode(n, depth + 1); if (r) return r; }
    return null;
  }
  if (hasType(node, 'Recipe')) return node;
  for (const key of ['@graph', 'mainEntity', 'mainEntityOfPage', 'itemListElement', 'item']) {
    if (node[key]) { const r = findRecipeNode(node[key], depth + 1); if (r) return r; }
  }
  return null;
}

function parseIsoDuration(d) {
  if (!d || typeof d !== 'string') return '';
  const m = d.match(/P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?/i);
  if (!m) return '';
  const mins = (Number(m[1] || 0) * 1440) + (Number(m[2] || 0) * 60) + Number(m[3] || 0);
  if (!mins) return '';
  return formatDurationLabel(mins * 60);
}

function flattenInstructions(inst) {
  const out = [];
  const walk = (x) => {
    if (x == null) return;
    if (typeof x === 'string') {
      const t = x.replace(/<\/(p|li|div)>/gi, '\n').replace(/<br\s*\/?>/gi, '\n');
      cleanText(t).split(/\n+/).map((s) => s.trim()).filter(Boolean).forEach((s) => out.push(stripStepNumber(s)));
      return;
    }
    if (Array.isArray(x)) { x.forEach(walk); return; }
    if (typeof x === 'object') {
      if (hasType(x, 'HowToSection')) {
        if (x.name) out.push('# ' + cleanText(x.name));
        walk(x.itemListElement || x.steps);
        return;
      }
      if (x.itemListElement && !x.text) { walk(x.itemListElement); return; }
      const txt = x.text || x.name || x.description;
      if (txt) walk(String(txt));
    }
  };
  walk(inst);
  return out;
}

function stripStepNumber(s) {
  return s.replace(/^(?:step|paso)?\s*\d+\s*[.):-]\s*/i, '').trim();
}

function pickImage(img) {
  for (const i of asArray(img)) {
    if (typeof i === 'string' && i) return i;
    if (i && typeof i === 'object') {
      const u = i.url || i.contentUrl || (i['@id'] && /^https?:/.test(i['@id']) ? i['@id'] : '');
      if (u) return asArray(u)[0];
    }
  }
  return '';
}

function parseServings(y) {
  let servings = null, yieldText = '';
  for (const v of asArray(y)) {
    const m = String(v).match(/\d+/);
    if (m && servings == null) servings = Number(m[0]);
    const t = cleanText(v);
    if (t.length > yieldText.length) yieldText = t;
  }
  if (/^\d+$/.test(yieldText)) yieldText = `${yieldText} servings`;
  return { servings, yieldText };
}

function splitKeywords(k) {
  if (!k) return [];
  const list = Array.isArray(k) ? k : String(k).split(',');
  return list.map((s) => cleanText(s)).filter(Boolean);
}

export function extractRecipeFromHtml(html, pageUrl = '') {
  const scripts = [];
  const re = /<script[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) scripts.push(m[1]);
  let recipe = null;
  for (const raw of scripts) {
    let data;
    const body = raw.trim().replace(/^<!--|-->$/g, '');
    try { data = JSON.parse(body); } catch {
      try { data = JSON.parse(body.replace(/[\u0000-\u001F]+/g, ' ')); } catch { continue; }
    }
    recipe = findRecipeNode(data);
    if (recipe) break;
  }
  if (!recipe) return null;

  const { servings, yieldText } = parseServings(recipe.recipeYield);
  let image = pickImage(recipe.image);
  if (image && pageUrl) { try { image = new URL(image, pageUrl).href; } catch { /* keep */ } }

  const suggestedTags = [
    ...asArray(recipe.recipeCategory).flatMap(splitKeywords),
    ...asArray(recipe.recipeCuisine).flatMap(splitKeywords),
  ];

  return {
    title: cleanText(recipe.name) || 'Untitled recipe',
    ingredients: asArray(recipe.recipeIngredient || recipe.ingredients).map(cleanText).filter(Boolean),
    steps: flattenInstructions(recipe.recipeInstructions),
    servings,
    yieldText,
    prepTime: parseIsoDuration(recipe.prepTime),
    cookTime: parseIsoDuration(recipe.cookTime),
    totalTime: parseIsoDuration(recipe.totalTime),
    imageUrl: image,
    suggestedTags: [...new Set(suggestedTags.map((t) => t.trim()).filter((t) => t && t.length < 30))],
  };
}

// ---------- Import from pasted text ----------

const ING_HEAD = /^\s*(ingredients?|you(?:'|’)ll need|what you need|ingredientes|lo que necesitas|necesitas)\s*:?\s*$/i;
const STEP_HEAD = /^\s*(instructions?|directions?|method|steps|preparation|how to make( it)?|instrucciones|preparaci[oó]n|procedimiento|modo de preparaci[oó]n|pasos|elaboraci[oó]n)\s*:?\s*$/i;
const NOTE_HEAD = /^\s*(notes?|tips?|recipe notes?|notas?|consejos?)\s*:?\s*$/i;

export function parsePastedRecipe(text) {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.replace(/^[\s•*·▢☐-]+/, '').trim());
  const result = { title: '', ingredients: [], steps: [], notes: '' };
  let mode = 'title';
  let sawHeader = false;
  for (const line of lines) {
    if (!line) continue;
    if (ING_HEAD.test(line)) { mode = 'ing'; sawHeader = true; continue; }
    if (STEP_HEAD.test(line)) { mode = 'steps'; sawHeader = true; continue; }
    if (NOTE_HEAD.test(line)) { mode = 'notes'; sawHeader = true; continue; }
    if (mode === 'title') {
      if (!result.title) { result.title = line; continue; }
      if (sawHeader) continue;
      mode = 'guess';
    }
    if (mode === 'ing') result.ingredients.push(line);
    else if (mode === 'steps') result.steps.push(stripStepNumber(line));
    else if (mode === 'notes') result.notes += (result.notes ? '\n' : '') + line;
    else if (mode === 'guess') {
      // No headings: short lines starting with a number are ingredients
      if (QTY_RE.test(line) && line.length < 80 && !/^\d+\s*[.)]/.test(line)) result.ingredients.push(line);
      else result.steps.push(stripStepNumber(line));
    }
  }
  if (!result.title) result.title = 'Untitled recipe';
  return result;
}
