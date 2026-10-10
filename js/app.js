import * as C from './core.js';
import * as S from './store.js';
import { IMAGERY, GAME, APP_VERSION } from './config.js';
import { createSatView } from './satview.js';
import { initTheme, setPref } from './theme.js';

const $ = (sel) => document.querySelector(sel);
const el = {
  map: $('#map'), mapWide: $('#map-wide'), veilBar: $('#veil-bar'), veilCount: $('#veil-count'), hint: $('#hint-label'), pips: $('#pips'), veil: $('#veil'), veilMsg: $('#veil-msg'), veilRetry: $('#veil-retry'),
  form: $('#guess-form'), input: $('#guess-input'), btn: $('#guess-btn'), list: $('#suggestions'),
  guesses: $('#guesses'), result: $('#result'), play: $('#play'), stage: $('#stage'), left: $('#left'),
  tools: $('#tools'), btnHint: $('#btn-hint'), btnZoom: $('#btn-zoom'), sheet: $('#sheet'),
  hintsUsed: $('#hints-used'), hintsList: $('#hints-list'),
  modeSeg: $('#mode-seg'), diffSeg: $('#diff-seg'), hardToggle: $('#hard-toggle'), toast: $('#toast'),
};

const game = {
  main: [], top: [], hardList: [], hardPool: [], fullLoaded: false, hardLoaded: false, meta: null,
  byId: new Map(), mainIndex: [], fullIndex: [],
  mode: 'daily', hard: false, diff: 'medium',
  round: null, // { kind, date, answer, log, results, hints, zoomed, done, won, cap }
  selected: null, token: 0, lastPracticeId: null,
};
// Test hook: only on a local development host, so the answer is not one console command away on the live site.
if (/^(localhost|127\.0\.0\.1|\[::1\]|[^.]+\.localhost)$/.test(location.hostname)) window.__ag = game;
game.config = IMAGERY; // tests may shorten the tile timeout
game.retinaOverride = null; // tests may force the extra tile levels
Object.defineProperty(game, 'zoom', { get: () => (frontView().map ? frontView().map.getZoom() : null) });
Object.defineProperty(game, 'map', { get: () => frontView().map });
Object.defineProperty(game, 'views', { get: () => views });
Object.defineProperty(game, 'view', {
  get() {
    const v = frontView();
    if (!v.map || !game.round) return null;
    const s = v.map.getSize();
    const a = game.round.answer;
    const n = v.retinaLevels;
    return { W: s.x, H: s.y, zoom: v.map.getZoom(), fill: C.fillAt(a, s.x, s.y, v.map.getZoom()), retinaN: n, dpr: window.devicePixelRatio, tileLevel: v.map.getZoom() + n, nz: a.nz };
  },
});

const kindOf = () => (game.mode === 'practice' ? 'practice' : game.hard ? 'hard' : 'daily');
const spent = (r) => r.log.length;

// ---------- prefs ----------
const PREFS_KEY = 'airportGuesser.prefs.v2';
function loadPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}');
    if (p.mode === 'daily' || p.mode === 'practice') game.mode = p.mode;
    if (C.DIFFICULTIES[p.diff]) game.diff = p.diff;
    game.hard = p.hard === true;
  } catch { /* ignore */ }
}
function savePrefs() {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify({ mode: game.mode, diff: game.diff, hard: game.hard })); } catch { /* ignore */ }
}

// ---------- toast ----------
let toastTimer;
function toast(msg) {
  el.toast.textContent = msg;
  el.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.classList.remove('show'), 2200);
}

// ---------- map (locked: no pan, zoom, drag, keys or controls) ----------
// Two stacked, identical-size satellite views: `main` (the airfield) and `wide` (the zoom-out). The wide one is loaded
// in the background once the main view is complete, so Zoom out is just a visibility swap.
const dprNow = () => window.devicePixelRatio || 1;
const retinaNow = () => (game.retinaOverride != null ? game.retinaOverride : C.retinaLevels(dprNow()));
let awaiting = null; // the view the loading skeleton is currently waiting for

const views = {
  main: createSatView({ container: el.map, imagery: IMAGERY, onProgress: (d, t) => { if (awaiting === views.main) setProgress(d, t); } }),
  wide: createSatView({ container: el.mapWide, imagery: IMAGERY, onProgress: (d, t) => { if (awaiting === views.wide) setProgress(d, t); } }),
};
const frontView = () => (game.round && game.round.zoomed && !game.round.done ? views.wide : views.main);
function setFront() {
  const f = frontView();
  for (const v of Object.values(views)) v.container.classList.toggle('front', v === f);
}

// loading skeleton: spinner + progress (tiles loaded / total); fades out only when every tile is in
let hideTimer;
function showVeil(msg, retry = false, loading = false) {
  clearTimeout(hideTimer);
  el.veil.classList.remove('out');
  el.veilMsg.textContent = msg;
  el.veil.classList.toggle('loading', loading);
  el.veilRetry.hidden = !retry;
  el.veil.hidden = false;
}
const mark = (name) => { try { if (!performance.getEntriesByName(name).length) performance.mark(name); } catch { /* old browsers */ } };
function hideVeil() {
  if (el.veil.hidden) return;
  mark('ag:revealed');
  scheduleBackground();
  el.veil.classList.add('out');
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => { el.veil.hidden = true; el.veil.classList.remove('out'); }, 240);
}
function setProgress(done, total) {
  el.veilBar.style.width = total ? `${Math.round((100 * done) / total)}%` : '0%';
  el.veilCount.textContent = total ? `${done} / ${total} tiles` : '';
}

const retryAction = () => (game.round ? presentRound() : startMode());
el.veilRetry.addEventListener('click', (e) => { e.stopPropagation(); retryAction(); });
el.veil.addEventListener('click', () => { if (!el.veilRetry.hidden) retryAction(); }); // the whole state is tappable

function syncRetina() {
  const n = retinaNow();
  for (const v of Object.values(views)) v.setRetina(n);
}

/**
 * Centre + zooms for an airport at the current frame size. The zoom is the airport's own `a.z` (identical on every
 * device), never deeper than real imagery allows, and only wider than that when this frame is smaller than the reference
 * frames. The airfield is centred in the part of the frame not covered by the chips and the attribution pill.
 */
function viewParams(a) {
  syncRetina();
  const n = views.main.retinaLevels;
  const { W, H } = views.main.size();
  const ref = W < 520 ? C.REF_PHONE.pill : C.REF_DESKTOP.pill; // fixed pill height for the fit, so the zoom does not depend on measuring
  const z = C.finalZoom(a, W, H, n, { minZoom: IMAGERY.minZoom, maxZoom: IMAGERY.maxZoom - n, pill: ref });
  const lift = C.airfieldLift(W, H, ref, C.CHIPS_BOTTOM); // constants, not measurements: the inline preloader computes exactly the same view
  game.lift = lift;
  game.frame = { W, H }; // the frame this view was fitted to: the keyboard layout keeps the map at exactly this size
  return { center: views.main.shifted([a.view[0], a.view[1]], z, lift), zMain: z, zWide: C.zoomedOut(z), W, H, lift };
}

let presentToken = 0;
/** Show the round's current view (airfield, or the wider one after Zoom out); resolves with the load status. */
async function presentRound() {
  const r = game.round;
  if (!r) return 'idle';
  const my = ++presentToken;
  setFront();
  const { center, zMain, zWide } = viewParams(r.answer);
  const wide = r.zoomed && !r.done;
  const v = wide ? views.wide : views.main;
  const z = wide ? zWide : zMain;
  el.hint.textContent = wide ? 'Wider view' : 'Airfield view';
  if (v.isReady(center, z)) { hideVeil(); preloadWider(); return 'ok'; }
  awaiting = v;
  showVeil('Loading imagery', false, true);
  setProgress(0, v.tilesFor(center, z).length);
  const res = await v.load(center, z);
  if (my !== presentToken || res === 'superseded') return res;
  return finishLoad(res);
}

function finishLoad(res) {
  if (res === 'ok') { hideVeil(); preloadWider(); }
  else if (res === 'timeout') showVeil('Imagery is taking too long to load.', true);
  else showVeil('Imagery failed to load. Check your connection.', true);
  return res;
}

/** Warm the zoom-out view in the background once the main view is complete. */
function preloadWider() {
  const r = game.round;
  if (!r || r.done || r.zoomed || !C.canSpend(spent(r))) return;
  const { center, zWide } = viewParams(r.answer);
  if (views.wide.isReady(center, zWide) || views.wide.status === 'loading') return;
  views.wide.load(center, zWide).catch(() => {});
}

// ---------- rounds ----------
// The player's LOCAL calendar date picks the Daily: everyone with the same date on their clock gets the same airport.
const todayKey = () => C.localDateString();

// ---- data. The Daily needs only today's entry (inlined in the HTML by the deploy build, or data/daily.json); the full
// airport lists (autocomplete, Practice, old saved games) load later and never compete with the first image's tiles.
const fetchJson = (url, low = false) => fetch(url, low ? { priority: 'low' } : undefined).then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); });
let dailyJsonPromise = null;
if (window.__DAILY && window.__DAILY.meta) game.meta = window.__DAILY.meta;

/** Today's candidates: { daily: [airport of the day, fallback, ...], hard: [...] }, or null when no schedule is available. */
async function dailyEntries(date) {
  const inline = window.__DAILY;
  if (inline && inline.days && inline.days[date]) return inline.days[date];
  const load = (opts) => fetch('data/daily.json', opts).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  dailyJsonPromise ||= load();
  let dj = await dailyJsonPromise;
  if (!(dj && dj.days[date])) { dj = await load({ cache: 'reload' }); if (dj) dailyJsonPromise = Promise.resolve(dj); } // a stale cached copy: ask the network once
  if (dj && dj.meta && !game.meta) game.meta = dj.meta;
  return dj && dj.days[date] ? dj.days[date] : null;
}

let fullPromise = null, hardPromise = null;
/** airports.json: autocomplete index, Practice pools, answers of old saved games. */
async function ensureFull(loud = true) {
  if (game.fullLoaded) return true;
  if (loud) showVeil('Loading airports', false, true);
  fullPromise ||= (async () => {
    try {
      const data = await fetchJson('data/airports.json', !loud);
      game.main = data.airports;
      game.meta = data.meta || game.meta;
    } catch { return false; }
    for (const a of game.main) game.byId.set(a.id, a);
    game.mainIndex = C.prepareIndex(game.main);
    game.top = game.main.filter((a) => a.top).sort((a, b) => a.top - b.top);
    game.fullLoaded = true;
    indexUpdated();
    return true;
  })();
  const ok = await fullPromise;
  if (!ok) fullPromise = null;
  return ok;
}

/** airports-hard.json (the other airports): Hard/Practice pools and the complete autocomplete index. */
async function ensureHard(loud = true) {
  if (game.hardLoaded) return true;
  if (!(await ensureFull(loud))) return false;
  if (loud) showVeil('Loading airports', false, true);
  hardPromise ||= (async () => {
    try { game.hardList = (await fetchJson('data/airports-hard.json', !loud)).airports; } catch { return false; }
    for (const a of game.hardList) game.byId.set(a.id, a);
    game.fullIndex = C.prepareIndex([...game.main, ...game.hardList]);
    game.hardPool = [...game.main.filter((a) => !a.top), ...game.hardList]; // Hard pool = every airport outside the Daily top list
    game.hardLoaded = true;
    indexUpdated();
    return true;
  })();
  const ok = await hardPromise;
  if (!ok) hardPromise = null;
  return ok;
}
const warmData = () => ensureFull(false).then((ok) => ok && ensureHard(false)).then((ok) => { if (ok) tellServiceWorker({ type: 'cache-data', urls: ['data/airports.json', 'data/airports-hard.json'] }); return ok; });

function newRound(kind, date, answer) {
  return { kind, date, answer, log: [], results: [], hints: [], zoomed: false, done: false, won: false, guessed: new Map() };
}

/** Rebuild a saved Daily. Guesses are saved with a small snapshot of the airport, so no big list is needed (older saves are looked up). */
async function restoreRound(kind, saved, candidates) {
  let answer = candidates.find((c) => c.id === saved.id) || game.byId.get(saved.id);
  const needsLists = !answer || saved.log.some((e) => e.t === 'g' && !e.a && !game.byId.has(e.id));
  if (needsLists) {
    if (!(await ensureHard())) throw new Error('lists unavailable');
    answer = answer || game.byId.get(saved.id);
  }
  if (!answer) return null;
  const r = newRound(kind, saved.date, answer);
  for (const e of saved.log) {
    if (e.t === 'g') {
      const g = e.a ? { id: e.id, ...e.a } : game.byId.get(e.id);
      if (!g) continue;
      r.guessed.set(e.id, g);
      r.results.push(C.evaluateGuess(g, answer));
    } else if (e.t === 'h' && C.HINTS.some((h) => h.key === e.k)) r.hints.push(e.k);
    else if (e.t === 'z') r.zoomed = true;
    else continue;
    r.log.push(e);
  }
  r.done = !!saved.done;
  r.won = !!saved.won;
  return r;
}

async function startMode() {
  const token = ++game.token;
  stopCountdown();
  clearSelection();
  closeList();
  closeSheet();
  game.round = null;
  renderChrome();
  awaiting = views.main;
  showVeil('Loading imagery', false, true);

  const kind = kindOf();
  const date = kind === 'practice' ? null : todayKey();
  let candidates = null;
  if (kind === 'practice') {
    if (!(await (game.hard ? ensureHard() : ensureFull()))) {
      if (token === game.token) showVeil('Could not load the airport data. Check your connection and retry.', true);
      return;
    }
    if (token !== game.token) return;
    candidates = C.practiceOrder(game.hard ? game.hardPool : game.main, game.hard ? null : game.diff).filter((a) => a.id !== game.lastPracticeId);
  } else {
    const entries = await dailyEntries(date);
    if (token !== game.token) return;
    if (entries) candidates = entries[kind];
    else { // no schedule (plain static server, very stale cache): work it out from the full lists
      if (!(await ensureHard())) { showVeil('Could not load the airport data. Check your connection and retry.', true); return; }
      if (token !== game.token) return;
      candidates = kind === 'daily' ? C.dailyTopOrder(game.top, date).slice(0, 3) : C.dailyOrder(game.hardPool, date, 'hard:').slice(0, 3);
    }
  }

  // Resume today's daily from storage: the airport was fixed when first played.
  if (kind !== 'practice') {
    const saved = S.loadDaily(kind);
    if (saved && saved.date === date) {
      let r = null;
      try { r = await restoreRound(kind, saved, candidates); } catch {
        if (token === game.token) showVeil('Could not load the airport data. Check your connection and retry.', true);
        return;
      }
      if (token !== game.token) return;
      if (r) {
        game.round = r;
        renderAll();
        mark('ag:airport-known');
        await presentRound();
        return;
      }
    }
  }

  // Start loading the first candidate's tiles right away. A candidate whose tiles still fail after one retry is skipped
  // (deterministic fallback order for the Daily); a stalled network stops here with a tap-to-retry state.
  let answer = null;
  mark('ag:airport-known');
  for (const cand of candidates.slice(0, GAME.maxProbeAttempts)) {
    const { center, zMain } = viewParams(cand); // no per-device skipping: every device must pick the same Daily airport
    awaiting = views.main;
    setFront();
    setProgress(0, views.main.tilesFor(center, zMain).length);
    const res = await views.main.load(center, zMain);
    if (token !== game.token) return;
    if (res === 'ok') { answer = cand; break; }
    if (res === 'timeout') return showVeil('Imagery is taking too long to load.', true);
  }
  if (!answer) {
    showVeil('Satellite imagery is unavailable right now. Check your connection and retry.', true);
    return;
  }
  const r = newRound(kind, date, answer);
  game.round = r;
  if (kind === 'practice') game.lastPracticeId = answer.id; else persist();
  renderAll();
  setFront();
  hideVeil();
  preloadWider();
}

/** Test hook: start a practice round on a specific airport (the data is client-side anyway). */
game.viewParams = (a) => viewParams(a); // test hook
game.wikiRow = wikiRow; // test hook
game.debugStart = async (id) => {
  const token = ++game.token;
  closeSheet(); clearSelection(); closeList();
  await ensureHard();
  const a = game.byId.get(id);
  game.round = null;
  const { center, zMain } = viewParams(a);
  awaiting = views.main;
  showVeil('Loading imagery', false, true);
  setProgress(0, views.main.tilesFor(center, zMain).length);
  setFront();
  const res = await views.main.load(center, zMain);
  if (token !== game.token) return { status: 'superseded' };
  game.round = newRound('practice', null, a);
  renderAll();
  setFront();
  if (res === 'ok') { hideVeil(); preloadWider(); } else finishLoad(res);
  return { status: res, z: zMain };
};

function persist() {
  const r = game.round;
  if (r.kind === 'practice') return;
  S.saveDaily(r.kind, { date: r.date, id: r.answer.id, log: r.log, done: r.done, won: r.won });
}

/** Common tail of every spend (guess / hint / zoom-out): check for the end, save, redraw. */
function afterSpend({ zoomChanged = false } = {}) {
  const r = game.round;
  const last = r.results[r.results.length - 1];
  if (last && last.correct && r.log[r.log.length - 1].t === 'g') { r.done = true; r.won = true; }
  else if (spent(r) >= C.MAX_GUESSES) { r.done = true; r.won = false; }
  persist();
  if (r.done) S.recordResult(r.kind, r.won, spent(r), r.date || todayKey());
  closeSheet();
  if (zoomChanged || r.done) presentRound();
  renderAll(true);
  if (r.done) el.result.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function submitGuess() {
  const r = game.round, g = game.selected;
  if (!r || r.done || !g) return;
  r.results.push(C.evaluateGuess(g, r.answer));
  r.guessed.set(g.id, g);
  r.log.push({ t: 'g', id: g.id, a: { name: g.name, iata: g.iata, icao: g.icao, lat: g.lat, lon: g.lon } }); // enough to restore the row without the big list
  clearSelection();
  closeList();
  afterSpend();
  if (!r.done && !coarse()) el.input.focus();
}

function useHint(key) {
  const r = game.round;
  if (!r || r.done || !C.canSpend(spent(r)) || r.hints.includes(key)) return;
  r.hints.push(key);
  r.log.push({ t: 'h', k: key });
  afterSpend();
}

function useZoomOut() {
  const r = game.round;
  if (!r || r.done || r.zoomed || !C.canSpend(spent(r))) return;
  r.zoomed = true;
  r.log.push({ t: 'z' });
  afterSpend({ zoomChanged: true });
}

const coarse = () => window.matchMedia('(pointer: coarse)').matches;

// ---------- hint / zoom sheet (menu + confirmation) ----------
let sheet = null; // null | { type: 'hints' } | { type: 'confirm', what: 'zoom' | 'hint', key }
function closeSheet() { sheet = null; renderSheet(); }
function renderSheet() {
  const r = game.round;
  if (!sheet || !r || r.done) { el.sheet.hidden = true; el.sheet.innerHTML = ''; return; }
  const left = C.attemptsLeft(spent(r));
  const after = `You'll have ${left - 1} left.`;
  let html = '';
  if (sheet.type === 'hints') {
    html = `<h4>Need a hint?</h4><p>Each hint costs 1 guess. ${left} left.</p><div class="opts">${C.HINTS.map((h) => {
      const used = r.hints.includes(h.key);
      const off = used || !C.hintAvailable(h, r.answer);
      return `<button type="button" class="opt" data-hint="${h.key}" ${off ? 'disabled' : ''}>${h.label}<small>${used ? 'Already used' : off ? 'Not available' : '−1 guess'}</small></button>`;
    }).join('')}</div><button type="button" class="cancel" data-cancel>Cancel</button>`;
  } else if (sheet.what === 'zoom') {
    html = `<h4>Zoom out for 1 guess?</h4><p>Shows a wider view. You can do this once per game. ${after}</p>
      <div class="row-btns"><button type="button" class="btn" data-cancel>Cancel</button><button type="button" class="btn primary" data-confirm>Zoom out (−1 guess)</button></div>`;
  } else {
    const h = C.HINTS.find((x) => x.key === sheet.key);
    html = `<h4>Reveal: ${h.label.toLowerCase()}?</h4><p>This costs 1 guess. ${after}</p>
      <div class="row-btns"><button type="button" class="btn" data-cancel>Cancel</button><button type="button" class="btn primary" data-confirm>Reveal (−1 guess)</button></div>`;
  }
  el.sheet.innerHTML = html;
  el.sheet.hidden = false;
}
el.sheet.addEventListener('click', (e) => {
  const t = e.target.closest('button');
  if (!t) return;
  if (t.hasAttribute('data-cancel')) closeSheet();
  else if (t.dataset.hint) { sheet = { type: 'confirm', what: 'hint', key: t.dataset.hint }; renderSheet(); }
  else if (t.hasAttribute('data-confirm')) { if (sheet.what === 'zoom') useZoomOut(); else useHint(sheet.key); }
});
el.btnHint.addEventListener('click', () => { closeList(); sheet = sheet && sheet.type === 'hints' ? null : { type: 'hints' }; renderSheet(); });
el.btnZoom.addEventListener('click', () => { closeList(); sheet = { type: 'confirm', what: 'zoom' }; renderSheet(); });

// ---------- rendering ----------
const nearSvg = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2.2" fill="currentColor" stroke="none"/></svg>';
const arrowSvg = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20V4M5.5 10.5 12 4l6.5 6.5"/></svg>';
const fmt = (n) => n.toLocaleString('en-US');
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const codeOf = (a) => a.iata || a.icao;

function renderChrome() {
  for (const b of el.modeSeg.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.mode === game.mode));
  el.hardToggle.checked = game.hard;
  el.diffSeg.hidden = !(game.mode === 'practice' && !game.hard);
  for (const b of el.diffSeg.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.diff === game.diff));
  el.input.placeholder = 'Airport, city or code';
}

function renderAll(animateLast = false) {
  const r = game.round;
  renderChrome();
  if (!r) return;
  const used = spent(r);

  // pips: one per attempt spent, in order
  el.pips.innerHTML = '';
  for (let i = 0; i < C.MAX_GUESSES; i++) {
    const e = r.log[i];
    const p = document.createElement('i');
    let cls = '';
    if (e) {
      if (e.t === 'g') cls = r.results.find((x) => x.id === e.id)?.correct ? ' hit' : ' miss';
      else cls = ' aid';
    }
    p.className = 'pip' + cls;
    el.pips.appendChild(p);
  }
  el.pips.setAttribute('aria-label', `${used} of ${C.MAX_GUESSES} attempts used`);
  el.left.innerHTML = `<b>${C.attemptsLeft(used)}</b> of ${C.MAX_GUESSES} attempts left`;

  // tools
  const canSpend = C.canSpend(used);
  const anyHint = C.HINTS.some((h) => !r.hints.includes(h.key) && C.hintAvailable(h, r.answer));
  el.btnHint.disabled = !canSpend || !anyHint;
  el.btnZoom.disabled = !canSpend || r.zoomed;
  el.btnZoom.innerHTML = r.zoomed ? 'Zoomed out' : 'Zoom out <span class="cost">−1 guess</span>';
  el.btnHint.title = canSpend ? '' : 'Hints need at least 2 attempts left';

  // used hints
  const chips = [];
  if (r.zoomed) chips.push(['View', 'Zoomed out']);
  for (const key of r.hints) {
    const h = C.HINTS.find((x) => x.key === key);
    chips.push([h.label, h.value(r.answer)]);
  }
  el.hintsUsed.hidden = chips.length === 0;
  el.hintsList.innerHTML = chips.map(([k, v]) => `<li><span>${esc(k)}</span><b>${esc(v)}</b></li>`).join('');

  // guess rows (newest on top)
  el.guesses.innerHTML = '';
  r.results.forEach((res, i) => {
    const g = r.guessed.get(res.id) || game.byId.get(res.id);
    const li = document.createElement('li');
    li.className = 'row' + (res.correct ? ' ok' : '');
    if (!(animateLast && i === r.results.length - 1)) li.style.animation = 'none';
    li.innerHTML = `
      <span class="n">${i + 1}</span>
      <div class="who"><span class="nm">${esc(g.name)}</span><span class="code">${esc(codeOf(g))}</span></div>
      <div class="nums">${res.correct ? '<b>Correct</b>' : `<b>${fmt(res.km)} km</b><span>${res.pct}%</span>`}<span class="bar"><i style="width:${res.pct}%"></i></span></div>
      <div class="dir" role="img" aria-label="${esc(C.directionPhrase(res))}">${res.near ? nearSvg : arrowSvg}<span>${res.correct ? 'HIT' : res.near ? 'NEAR' : res.dir}</span></div>`;
    if (!res.correct && !res.near) {
      const svg = li.querySelector('svg');
      const turn = `rotate(${C.arrowAngle(res.bearing).toFixed(1)}deg)`;
      if (animateLast && i === r.results.length - 1) { // only the newest arrow swings into place (the short way round); the others are simply there
        svg.style.transform = 'rotate(0deg)';
        requestAnimationFrame(() => requestAnimationFrame(() => { svg.style.transform = turn; }));
      } else { svg.style.transition = 'none'; svg.style.transform = turn; }
    }
    el.guesses.prepend(li);
  });
  el.play.hidden = r.done;
  renderSheet();
  renderResult();
}

// The Wikipedia link exists in the DOM only here, on the result card (game over): never during play, never prefetched.
const externalIcon = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>';
function wikiRow(a) {
  const { kind, url } = C.wikipediaLink(a);
  const label = kind === 'article' ? `Read about <b>${esc(a.name)}</b> on Wikipedia` : `Search Wikipedia for <b>${esc(a.name)}</b>`;
  return `<a class="wiki" href="${esc(url)}" target="_blank" rel="noopener noreferrer"><span class="wiki-text">${label}</span>${externalIcon}<span class="sr">(opens Wikipedia in a new tab)</span></a>`;
}

function renderResult() {
  const r = game.round;
  stopCountdown();
  if (!r.done) { el.result.hidden = true; el.result.textContent = ''; return; } // nothing of the previous answer (incl. its Wikipedia link) stays in the DOM
  const a = r.answer;
  el.result.hidden = false;
  el.result.className = 'result' + (r.won ? '' : ' lost');
  const place = [a.city, a.country].filter(Boolean).join(', ');
  el.result.innerHTML = `
    <p class="eyebrow">${r.won ? `Solved in ${spent(r)} of ${C.MAX_GUESSES}` : 'Out of attempts'}</p>
    <h2>${esc(a.name)}</h2>
    <p class="codes">${esc([a.iata, a.icao].filter(Boolean).join(' / '))}</p>
    <p class="where">${esc(place)}</p>
    ${wikiRow(a)}
    <div class="acts">
      <button type="button" class="btn primary" id="btn-share">Share</button>
      ${r.kind === 'practice' ? '<button type="button" class="btn" id="btn-next">Next airport</button>' : ''}
    </div>
    ${r.kind !== 'practice' ? '<p class="next">Next airport in <b id="countdown">--:--:--</b></p>' : ''}`;
  $('#btn-share').addEventListener('click', share);
  const next = $('#btn-next');
  if (next) next.addEventListener('click', () => startMode());
  if (r.kind !== 'practice') startCountdown();
}

// ---------- countdown ----------
let cdTimer = null;
function stopCountdown() { clearInterval(cdTimer); cdTimer = null; }
function startCountdown() {
  const tick = () => {
    const ms = C.msUntilNextLocalDay();
    const node = $('#countdown');
    if (!node) return stopCountdown();
    const s = Math.max(0, Math.floor(ms / 1000));
    node.textContent = [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60].map((n) => String(n).padStart(2, '0')).join(':');
    if (game.round && game.round.date && game.round.date !== todayKey()) { stopCountdown(); if (game.mode === 'daily') startMode(); }
  };
  tick();
  cdTimer = setInterval(tick, 1000);
}

// ---------- share ----------
function shareTitle(r) {
  if (r.kind === 'daily') return `Daily ${r.date}`;
  if (r.kind === 'hard') return `Hard Daily ${r.date}`;
  return game.hard ? 'Hard Practice' : `Practice · ${C.DIFFICULTIES[game.diff].label}`;
}
function shareEntries(r) {
  const byId = new Map(r.results.map((x) => [x.id, x]));
  return r.log.map((e) => (e.t === 'g' ? byId.get(e.id) : e.t === 'h' ? { hint: true } : { zoom: true }));
}
async function share() {
  const r = game.round;
  const url = /^https?:/.test(location.protocol) ? location.origin + location.pathname : '';
  const text = C.buildShareText({ entries: shareEntries(r), won: r.won, title: shareTitle(r), url });
  try {
    await navigator.clipboard.writeText(text);
    return toast('Copied to clipboard');
  } catch { /* fall through */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text; ta.setAttribute('readonly', ''); ta.style.cssText = 'position:fixed;opacity:0;top:0';
    document.body.appendChild(ta); ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    if (ok) return toast('Copied to clipboard');
  } catch { /* fall through */ }
  window.prompt('Copy your result:', text);
}

// ---------- autocomplete ----------
let active = -1, shown = [];
// full database in every mode once loaded; null while the lists are still downloading (queries typed meanwhile wait)
const searchIndex = () => (game.hardLoaded ? game.fullIndex : game.fullLoaded ? game.mainIndex : null);
function indexUpdated() { if (el.input.value && !game.selected && document.activeElement === el.input) renderList(); }
const hl = (text, q) => {
  const nq = C.normalize(q).replace(/ /g, '');
  if (!nq) return esc(text);
  // stripped = accent-free lowercase text; pos[i] = index in `text` that produced stripped[i]
  let stripped = '';
  const pos = [];
  for (let i = 0; i < text.length; i++) {
    const chunk = C.normalize(text[i]).replace(/ /g, '');
    for (const ch of chunk) { stripped += ch; pos.push(i); }
  }
  const idx = stripped.indexOf(nq);
  if (idx < 0) return esc(text);
  const start = pos[idx], end = pos[idx + nq.length - 1] + 1;
  return esc(text.slice(0, start)) + '<mark>' + esc(text.slice(start, end)) + '</mark>' + esc(text.slice(end));
};

function renderList() {
  const q = el.input.value;
  if (game.selected || !q.trim()) return closeList();
  const index = searchIndex();
  if (!index) { // lists not downloaded yet: start now (the player is typing) and show a placeholder; indexUpdated() re-runs this
    warmData();
    shown = []; active = -1;
    el.list.innerHTML = '<li class="noresults" role="presentation">Loading airports&hellip;</li>';
    el.list.hidden = false;
    el.input.setAttribute('aria-expanded', 'true');
    return;
  }
  const exclude = new Set(game.round ? game.round.results.map((r) => r.id) : []);
  shown = C.search(index, q, { exclude, limit: 6 });
  active = shown.length ? 0 : -1;
  el.list.innerHTML = '';
  if (!shown.length) el.list.innerHTML = '<li class="noresults" role="presentation">No matching airport</li>';
  shown.forEach((a, i) => {
    const li = document.createElement('li');
    li.id = 'opt-' + i;
    li.setAttribute('role', 'option');
    li.setAttribute('aria-selected', String(i === active));
    li.innerHTML = `<span class="s-name">${hl(a.name, q)}</span><span class="s-meta"><b>${esc(codeOf(a))}</b> &middot; ${esc(a.city ? a.city + ', ' : '')}${esc(a.countryCode)}</span>`;
    li.setAttribute('aria-label', C.suggestionLabel(a));
    li.addEventListener('pointerdown', (e) => e.preventDefault()); // keep input focus
    li.addEventListener('click', () => choose(a));
    el.list.appendChild(li);
  });
  el.list.hidden = false;
  el.input.setAttribute('aria-expanded', 'true');
  el.input.setAttribute('aria-activedescendant', active >= 0 ? 'opt-' + active : '');
}
function closeList() {
  el.list.hidden = true; shown = []; active = -1;
  el.input.setAttribute('aria-expanded', 'false');
  el.input.removeAttribute('aria-activedescendant');
}
function setActive(i) {
  if (!shown.length) return;
  active = (i + shown.length) % shown.length;
  [...el.list.children].forEach((li, k) => li.setAttribute('aria-selected', String(k === active)));
  el.input.setAttribute('aria-activedescendant', 'opt-' + active);
  el.list.children[active].scrollIntoView({ block: 'nearest' });
}
function choose(a) {
  game.selected = a;
  el.input.value = `${a.name} (${codeOf(a)})`;
  el.btn.disabled = false;
  closeList();
  if (coarse()) el.input.blur(); else el.input.focus();
}
function clearSelection() {
  game.selected = null;
  el.input.value = '';
  el.btn.disabled = true;
}

el.input.addEventListener('input', () => {
  game.selected = null;
  el.btn.disabled = true;
  renderList();
});
el.input.addEventListener('focus', () => { warmData(); if (el.input.value && !game.selected) renderList(); }); // first focus: the player is about to search
el.input.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') { e.preventDefault(); if (el.list.hidden) renderList(); else setActive(active + 1); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(active - 1); }
  else if (e.key === 'Escape') { closeList(); }
  else if (e.key === 'Enter') {
    e.preventDefault();
    if (!el.list.hidden && active >= 0) choose(shown[active]);
    else if (game.selected) submitGuess();
  } else if (e.key === 'Tab') closeList();
});
document.addEventListener('pointerdown', (e) => { if (!el.form.contains(e.target)) closeList(); });
el.form.addEventListener('submit', (e) => { e.preventDefault(); submitGuess(); });

// ---------- mode switching ----------
el.modeSeg.addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b || b.dataset.mode === game.mode) return;
  game.mode = b.dataset.mode; savePrefs(); startMode();
});
el.hardToggle.addEventListener('change', () => { game.hard = el.hardToggle.checked; savePrefs(); startMode(); });
el.diffSeg.addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b || b.dataset.diff === game.diff) return;
  game.diff = b.dataset.diff; savePrefs(); startMode();
});

// ---------- viewport / keyboard ----------
// The on-screen keyboard shrinks the visual viewport (iOS, and Android with interactive-widget=resizes-visual) or the layout
// viewport (older Android). While a touch player types, the layout switches to a compact one so the image, the input and the
// suggestions all stay on screen. The image itself is NEVER re-fitted for that: the map keeps the size its view was fitted to
// (game.frame) and is only scaled down to the compact frame, so zoom and framing are identical before, during and after typing.
// A re-fit happens only when the width changes (rotation, window resize): a height-only change is the keyboard or the browser bar.
let restH = 0, restW = 0, resizeTimer;
function onViewport() {
  const vv = window.visualViewport;
  const h = vv ? vv.height : window.innerHeight;
  const focused = document.activeElement === el.input;
  const widthChanged = restW !== 0 && window.innerWidth !== restW;
  if (window.innerWidth !== restW) { restW = window.innerWidth; restH = h; } // rotation / real resize: new reference height
  if (!focused) restH = Math.max(restH, h);
  const kb = focused && coarse() && h < restH * 0.78 && !!game.frame;
  const root = document.documentElement;
  root.style.setProperty('--vvh', h + 'px');
  const was = root.classList.contains('kb');
  if (kb) {
    const compact = Math.min(240, Math.max(110, h * 0.27)); // keep in sync with html.kb --map-h in the stylesheet
    root.style.setProperty('--fw', game.frame.W);
    root.style.setProperty('--fh', game.frame.H);
    root.style.setProperty('--fk', String(Math.min(1, compact / game.frame.H)));
  }
  root.classList.toggle('kb', kb);
  if (kb && !was) requestAnimationFrame(() => window.scrollTo({ top: 0 }));
  if (kb !== was) for (const v of Object.values(views)) v.size(); // the map container changed size: re-sync Leaflet (centre and zoom are kept)
  if (widthChanged) refit();
}
/** The locked view is fitted to the frame, so re-fit when the frame's WIDTH changed (rotation, window resize). */
function refit(delay = 150) {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { if (game.round) presentRound(); }, delay);
}
// the stage animates its height when the compact layout comes or goes: re-sync Leaflet's size when it has settled (view is kept)
el.stage.addEventListener('transitionend', (e) => { if (e.target === el.stage && e.propertyName === 'height') for (const v of Object.values(views)) v.size(); });
if (window.visualViewport) window.visualViewport.addEventListener('resize', onViewport);
window.addEventListener('resize', onViewport);
el.input.addEventListener('blur', () => setTimeout(onViewport, 50));
el.input.addEventListener('focus', () => setTimeout(onViewport, 50));
onViewport();

// ---------- extras: statistics, help, About & credits (loaded after the first image, or on first use) ----------
let extrasPromise = null;
const loadExtras = () => (extrasPromise ||= import('./extras.js').then((m) => m.init({ game, S, C, $, esc, kindOf, todayKey, APP_VERSION })));
for (const [sel, method] of [['#btn-stats', 'openStats'], ['#btn-help', 'openHelp'], ['#btn-about', 'openAbout']]) {
  $(sel).addEventListener('click', () => loadExtras().then((x) => x[method]()));
}
// theme switch: tiny and instant, so it stays in the main bundle (the first paint is handled by the inline script in <head>)
const themeSeg = $('#theme-seg');
function markTheme({ pref }) { for (const b of themeSeg.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.themePref === pref)); }
themeSeg.addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) markTheme(setPref(b.dataset.themePref)); });
initTheme(markTheme); // also follows the OS setting live while on System
$('#app-version').textContent = 'v' + APP_VERSION;

// ---------- after the first image: everything that must not compete with its tiles ----------
const idle = (fn) => ('requestIdleCallback' in window ? requestIdleCallback(fn, { timeout: 3000 }) : setTimeout(fn, 300));
let backgroundStarted = false;
/** Called once, when the first image is revealed. The big downloads wait for the zoom-out view's tiles (or 6 s). */
function scheduleBackground() {
  if (backgroundStarted) return;
  backgroundStarted = true;
  const wideSettled = () => {
    const r = game.round;
    const wants = r && !r.done && !r.zoomed && C.canSpend(spent(r));
    return !wants || ['ready', 'failed', 'timeout'].includes(views.wide.status);
  };
  let tries = 0;
  const poll = setInterval(() => { if (wideSettled() || ++tries > 30) { clearInterval(poll); go(); } }, 200);
  function go() {
    mark('ag:background-start');
    warmData();
    idle(async () => { const x = await loadExtras(); if (!S.hasSeenHelp()) { S.markHelpSeen(); x.openHelp(); } });
    idle(registerServiceWorker);
    cacheTilesInServiceWorker();
  }
}
// the first image's tiles go into the service worker's tile cache (they are already in the HTTP cache, so this costs no download)
function tellServiceWorker(msg) {
  if (!('serviceWorker' in navigator) || !/^https?:/.test(location.protocol)) return;
  navigator.serviceWorker.ready.then((reg) => reg.active && reg.active.postMessage(msg)).catch(() => {});
}
function cacheTilesInServiceWorker() {
  const r = game.round;
  if (!r) return;
  const { center, zMain } = viewParams(r.answer);
  tellServiceWorker({ type: 'cache-tiles', urls: views.main.tilesFor(center, zMain) });
  if (game.hardLoaded) tellServiceWorker({ type: 'cache-data', urls: ['data/airports.json', 'data/airports-hard.json'] });
}
function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || !/^https?:/.test(location.protocol)) return;
  navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then(() => cacheTilesInServiceWorker()).catch(() => {});
}

// ---------- date rollover ----------
// The Daily follows the local calendar date. If the clock passes midnight while the page stays open (any state of the game),
// switch to the new day. The schedule is already in memory (inline / daily.json), so this does not trigger a full load.
function checkRollover() {
  const r = game.round;
  if (r && r.date && r.date !== todayKey() && game.mode === 'daily') startMode();
}
setInterval(checkRollover, 10000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) checkRollover(); });

// ---------- boot ----------
async function boot() {
  loadPrefs();
  renderChrome();
  if (el.input.value) renderList(); // characters typed while the page was loading
  await startMode();
}
boot();
