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
  dlgHelp: $('#dlg-help'), dlgStats: $('#dlg-stats'), statsBody: $('#stats-body'), statsSeg: $('#stats-seg'),
};

const game = {
  main: [], top: [], hardList: [], hardPool: [], hardLoaded: false,
  byId: new Map(), mainIndex: [], fullIndex: [],
  mode: 'daily', hard: false, diff: 'medium',
  round: null, // { kind, date, answer, log, results, hints, zoomed, done, won, cap }
  selected: null, token: 0, lastPracticeId: null,
};
window.__ag = game; // convenience for tests/debugging; the dataset is client-side anyway
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
function hideVeil() {
  if (el.veil.hidden) return;
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

/** Half the height of the attribution pill: the airfield is lifted by this much so the pill never covers it. */
function attributionLift(H) {
  const el = views.main.container.querySelector('.leaflet-control-attribution');
  const h = el ? el.getBoundingClientRect().height : 0;
  return Math.round(Math.min(h / 2 + 2, 0.05 * H));
}

/** Centre + zooms for an airport at the current frame size: fitted to the airfield, never deeper than real imagery. */
function viewParams(a) {
  syncRetina();
  const n = views.main.retinaLevels;
  const { W, H } = views.main.size();
  const z = C.finalZoom(a, W, H, n, { minZoom: IMAGERY.minZoom, maxZoom: IMAGERY.maxZoom - n });
  const lift = attributionLift(H);
  game.lift = lift;
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
const todayKey = () => C.utcDateString();

// The other airports (regional, small, remote). Needed for Hard mode, and for autocomplete in every mode
// ("search the full database"), so it is also fetched quietly in the background after the first image is up.
let hardPromise = null;
async function ensureHard(loud = true) {
  if (game.hardLoaded) return true;
  if (loud) showVeil('Loading airports', false, true);
  hardPromise ||= (async () => {
    try {
      const res = await fetch('data/airports-hard.json');
      if (!res.ok) throw new Error(res.status);
      game.hardList = (await res.json()).airports;
    } catch {
      return false;
    }
    for (const a of game.hardList) game.byId.set(a.id, a);
    game.fullIndex = C.prepareIndex([...game.main, ...game.hardList]);
    game.hardPool = [...game.main.filter((a) => !a.top), ...game.hardList]; // Hard pool = every airport not in the Daily top list
    game.hardLoaded = true;
    return true;
  })();
  const ok = await hardPromise;
  if (!ok) hardPromise = null;
  return ok;
}

function newRound(kind, date, answer) {
  return { kind, date, answer, log: [], results: [], hints: [], zoomed: false, done: false, won: false };
}

function restoreRound(kind, saved) {
  const answer = game.byId.get(saved.id);
  if (!answer) return null;
  const r = newRound(kind, saved.date, answer);
  for (const e of saved.log) {
    if (e.t === 'g' && game.byId.has(e.id)) r.results.push(C.evaluateGuess(game.byId.get(e.id), answer));
    else if (e.t === 'h' && C.HINTS.some((h) => h.key === e.k)) r.hints.push(e.k);
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

  if (game.hard && !(await ensureHard())) {
    if (token !== game.token) return;
    showVeil('Could not load the Hard mode airports. Check your connection and retry.', true);
    return;
  }
  if (token !== game.token) return;

  const kind = kindOf();

  // Resume today's daily from storage: the airport was fixed when first played.
  if (kind !== 'practice') {
    const saved = S.loadDaily(kind);
    if (saved && saved.date === todayKey()) {
      // a saved guess may be an airport from the other file
      if (saved.log.some((e) => e.t === 'g' && !game.byId.has(e.id)) && !(await ensureHard())) {
        if (token !== game.token) return;
        showVeil('Could not load the airport data. Check your connection and retry.', true);
        return;
      }
      if (token !== game.token) return;
      const r = restoreRound(kind, saved);
      if (r) {
        game.round = r;
        renderAll();
        await presentRound();
        return;
      }
    }
  }

  const date = kind === 'practice' ? null : todayKey();
  const order = kind === 'practice'
    ? C.practiceOrder(game.hard ? game.hardPool : game.main, game.hard ? null : game.diff).filter((a) => a.id !== game.lastPracticeId)
    : kind === 'daily'
      ? C.dailyTopOrder(game.top, date) // the busiest airports, each once per cycle
      : C.dailyOrder(game.hardPool, date, 'hard:');

  // Start loading the first candidate's tiles right away. A candidate whose tiles still fail after one retry is skipped
  // (deterministic fallback order for the Daily); a stalled network stops here with a tap-to-retry state.
  let answer = null;
  game.round = null;
  for (const cand of order.slice(0, GAME.maxProbeAttempts)) {
    const { center, zMain, W, H } = viewParams(cand);
    if (C.fillAt(cand, W, H, zMain) < C.MIN_FILL * 0.8) continue; // frame far narrower than the reference phone
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
game.debugStart = async (id) => {
  const token = ++game.token;
  closeSheet(); clearSelection(); closeList();
  if (!game.hardLoaded) await ensureHard();
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
  r.log.push({ t: 'g', id: g.id });
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
    const g = game.byId.get(res.id);
    const li = document.createElement('li');
    li.className = 'row' + (res.correct ? ' ok' : '');
    if (!(animateLast && i === r.results.length - 1)) li.style.animation = 'none';
    li.innerHTML = `
      <span class="n">${i + 1}</span>
      <div class="who"><span class="nm">${esc(g.name)}</span><span class="code">${esc(codeOf(g))}</span></div>
      <div class="nums">${res.correct ? '<b>Correct</b>' : `<b>${fmt(res.km)} km</b><span>${res.pct}%</span>`}<span class="bar"><i style="width:${res.pct}%"></i></span></div>
      <div class="dir" aria-label="${res.correct ? 'Correct' : `Answer is ${res.dir} of this airport`}">${arrowSvg}<span>${res.correct ? 'HIT' : res.dir}</span></div>`;
    if (!res.correct) {
      const svg = li.querySelector('svg');
      svg.style.transform = 'rotate(0deg)';
      requestAnimationFrame(() => requestAnimationFrame(() => { svg.style.transform = `rotate(${res.bearing.toFixed(1)}deg)`; }));
    }
    el.guesses.prepend(li);
  });
  el.play.hidden = r.done;
  renderSheet();
  renderResult();
}

function renderResult() {
  const r = game.round;
  stopCountdown();
  if (!r.done) { el.result.hidden = true; return; }
  const a = r.answer;
  el.result.hidden = false;
  el.result.className = 'result' + (r.won ? '' : ' lost');
  const place = [a.city, a.country].filter(Boolean).join(', ');
  el.result.innerHTML = `
    <p class="eyebrow">${r.won ? `Solved in ${spent(r)} of ${C.MAX_GUESSES}` : 'Out of attempts'}</p>
    <h2>${esc(a.name)}</h2>
    <p class="codes">${esc([a.iata, a.icao].filter(Boolean).join(' / '))}</p>
    <p class="where">${esc(place)}</p>
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
    const ms = C.msUntilNextUtcDay();
    const node = $('#countdown');
    if (!node) return stopCountdown();
    const s = Math.max(0, Math.floor(ms / 1000));
    node.textContent = [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60].map((n) => String(n).padStart(2, '0')).join(':');
    if (game.round && game.round.date !== C.utcDateString()) { stopCountdown(); if (game.mode === 'daily') startMode(); }
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
const searchIndex = () => (game.hardLoaded ? game.fullIndex : game.mainIndex); // full database in every mode once loaded
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
  const exclude = new Set(game.round ? game.round.results.map((r) => r.id) : []);
  shown = C.search(searchIndex(), q, { exclude, limit: 6 });
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
el.input.addEventListener('focus', () => { if (el.input.value && !game.selected) renderList(); });
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

// ---------- stats ----------
let statsTab = 'daily';
function renderStats() {
  for (const b of el.statsSeg.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.stats === statsTab));
  const st = S.loadStats();
  const m = st[statsTab];
  const rate = m.played ? Math.round((100 * m.wins) / m.played) : 0;
  const max = Math.max(1, ...m.dist);
  const tiles = [['Played', m.played], ['Win rate', rate + '%']];
  if (statsTab !== 'practice') {
    const streak = S.displayStreak(st, statsTab, C.utcDateString());
    tiles.push(['Streak', streak.current], ['Best', streak.best]);
  } else tiles.push(['Wins', m.wins], ['Losses', m.dist[5]]);
  const labels = ['1', '2', '3', '4', '5', 'X'];
  const top = Math.max(...m.dist);
  el.statsBody.innerHTML = `
    <div class="tiles">${tiles.map(([k, v]) => `<div class="tile"><b>${v}</b><span>${k}</span></div>`).join('')}</div>
    <div class="dist"><h3>Attempts used</h3>
      ${m.dist.map((n, i) => `<div class="drow${n && n === top ? ' top' : ''}"><span>${labels[i]}</span><div class="track"><div class="fill" style="width:${Math.max(n ? 8 : 0, (100 * n) / max)}%">${n || ''}</div></div></div>`).join('')}
    </div>`;
}
$('#btn-stats').addEventListener('click', () => { statsTab = kindOf(); renderStats(); el.dlgStats.showModal(); });
el.statsSeg.addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) { statsTab = b.dataset.stats; renderStats(); } });
$('#btn-help').addEventListener('click', () => el.dlgHelp.showModal());
for (const d of [el.dlgHelp, el.dlgStats]) d.addEventListener('click', (e) => { if (e.target === d) d.close(); });

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
// The on-screen keyboard shrinks the visual viewport (iOS) or the layout viewport (Android). Either way, while the
// input is focused and the viewport is much shorter than at rest, switch to a compact layout (smaller map, no chrome)
// so the image, the input and the suggestions all stay on screen.
let restH = 0, restW = 0, resizeTimer;
function onViewport() {
  const vv = window.visualViewport;
  const h = vv ? vv.height : window.innerHeight;
  const focused = document.activeElement === el.input;
  if (window.innerWidth !== restW) { restW = window.innerWidth; restH = h; } // rotation / real resize
  if (!focused) restH = Math.max(restH, h);
  const kb = focused && h < restH * 0.78;
  const root = document.documentElement;
  root.style.setProperty('--vvh', h + 'px');
  const was = root.classList.contains('kb');
  root.classList.toggle('kb', kb);
  if (kb && !was) requestAnimationFrame(() => window.scrollTo({ top: 0 }));
  if (kb !== was) refit(320);
}
/** The locked view is fitted to the viewport, so re-fit whenever the image area changes size. */
function refit(delay = 150) {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { if (game.round) presentRound(); }, delay);
}
if (window.visualViewport) window.visualViewport.addEventListener('resize', onViewport);
window.addEventListener('resize', () => { onViewport(); refit(); });
el.input.addEventListener('blur', () => setTimeout(onViewport, 50));
el.input.addEventListener('focus', () => setTimeout(onViewport, 50));
onViewport();

// ---------- about & credits ----------
const versionLabel = 'v' + APP_VERSION.replace(/\.0$/, '');
$('#app-version').textContent = versionLabel;
let aboutFilled = false;
async function fillAbout() {
  $('#about-version').textContent = APP_VERSION;
  const date = game.meta && game.meta.ourairports_retrieved;
  $('#about-data-date').textContent = date || 'unknown';
  if (aboutFilled) return;
  try {
    const rank = await (await fetch('data/top50.json')).json();
    $('#about-rank-year').textContent = rank.year;
    $('#about-rank-date').textContent = rank.retrieved;
  } catch { /* the static text stays */ }
  try {
    const res = await fetch('data/credits.json');
    const c = await res.json();
    $('#oss-list').innerHTML = c.software.map((p) => `<li><a href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.name)}</a> ${esc(p.version)}, ${esc(p.license)} licence. ${esc(p.purpose)}</li>`).join('');
    aboutFilled = true;
  } catch { $('#oss-list').innerHTML = '<li>Open-source software list unavailable offline. See THIRD_PARTY_NOTICES.md in the repository.</li>'; }
}
$('#btn-about').addEventListener('click', () => { fillAbout(); $('#dlg-about').showModal(); $('#dlg-about .dlg-body').scrollTop = 0; });
$('#dlg-about').addEventListener('click', (e) => { if (e.target === e.currentTarget) e.currentTarget.close(); });

// ---------- theme ----------
const themeSeg = $('#theme-seg');
function markTheme({ pref }) {
  for (const b of themeSeg.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.themePref === pref));
}
themeSeg.addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) markTheme(setPref(b.dataset.themePref)); });
initTheme(markTheme); // also follows the OS setting live while on System

// ---------- boot ----------
async function boot() {
  loadPrefs();
  renderChrome();
  showVeil('Loading airports', false, true);
  try {
    const res = await fetch('data/airports.json');
    if (!res.ok) throw new Error(res.status);
    const data = await res.json();
    game.main = data.airports;
    game.meta = data.meta || null;
  } catch {
    showVeil('Could not load the airport data.', true);
    el.veilRetry.onclick = () => location.reload();
    return;
  }
  for (const a of game.main) game.byId.set(a.id, a);
  game.mainIndex = C.prepareIndex(game.main);
  game.top = game.main.filter((a) => a.top).sort((a, b) => a.top - b.top);
  if (!S.hasSeenHelp()) { el.dlgHelp.showModal(); S.markHelpSeen(); }
  await startMode();
  ensureHard(false); // background: full-database autocomplete in every mode
}

if ('serviceWorker' in navigator && /^https?:/.test(location.protocol)) {
  // When a new service worker takes over an already-controlled page, reload once so users get the new version.
  const hadController = !!navigator.serviceWorker.controller;
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (hadController && !reloaded) { reloaded = true; location.reload(); }
  });
  navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).catch(() => {});
}
boot();
