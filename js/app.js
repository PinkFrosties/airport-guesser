import * as C from './core.js';
import * as S from './store.js';
import { IMAGERY, GAME } from './config.js';

const $ = (sel) => document.querySelector(sel);
const el = {
  map: $('#map'), hint: $('#hint-label'), pips: $('#pips'), veil: $('#veil'), veilMsg: $('#veil-msg'), veilRetry: $('#veil-retry'),
  form: $('#guess-form'), input: $('#guess-input'), btn: $('#guess-btn'), list: $('#suggestions'),
  guesses: $('#guesses'), result: $('#result'), play: $('#play'), stage: $('#stage'),
  modeSeg: $('#mode-seg'), diffSeg: $('#diff-seg'), toast: $('#toast'),
  dlgHelp: $('#dlg-help'), dlgStats: $('#dlg-stats'), statsBody: $('#stats-body'), statsSeg: $('#stats-seg'),
};

const game = {
  airports: [], byId: new Map(), index: [],
  mode: 'daily', diff: 'medium',
  round: null, // { mode, date, answer, results: [], done, won }
  selected: null, token: 0, lastPracticeId: null,
};
window.__ag = game; // convenience for tests/debugging; the dataset is client-side anyway
Object.defineProperty(game, 'zoom', { get: () => (map ? map.getZoom() : null) });

// ---------- prefs ----------
const PREFS_KEY = 'airportGuesser.prefs.v1';
function loadPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}');
    if (p.mode === 'daily' || p.mode === 'practice') game.mode = p.mode;
    if (C.DIFFICULTIES[p.diff]) game.diff = p.diff;
  } catch { /* ignore */ }
}
function savePrefs() {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify({ mode: game.mode, diff: game.diff })); } catch { /* ignore */ }
}

// ---------- toast ----------
let toastTimer;
function toast(msg) {
  el.toast.textContent = msg;
  el.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.classList.remove('show'), 2200);
}

// ---------- map ----------
// Leaflet drops a setView issued while a zoom animation is running, so re-apply the wanted view when it ends.
let desired = null;
let map = null, layer = null, tileStats = { ok: 0, err: 0 };

function tileUrl(z, x, y) {
  return IMAGERY.url.replace('{z}', z).replace('{x}', x).replace('{y}', y).replace('{s}', (IMAGERY.subdomains || '')[0] || '');
}

function ensureMap() {
  if (map) return;
  map = L.map(el.map, {
    zoomControl: false, attributionControl: true, dragging: false, touchZoom: false, scrollWheelZoom: false,
    doubleClickZoom: false, boxZoom: false, keyboard: false, tap: false, zoomSnap: 1, zoomAnimation: true,
    fadeAnimation: true, inertia: false, minZoom: IMAGERY.minZoom, maxZoom: IMAGERY.maxZoom, worldCopyJump: false,
  });
  map.attributionControl.setPrefix(false);
  map.on('zoomend', () => {
    if (desired && map.getZoom() !== desired.zoom) map.setView(desired.center, desired.zoom, { animate: false });
  });
  layer = L.tileLayer(IMAGERY.url, {
    attribution: IMAGERY.attribution, minZoom: IMAGERY.minZoom, maxZoom: IMAGERY.maxZoom,
    subdomains: IMAGERY.subdomains || 'abc', keepBuffer: 2, updateWhenZooming: false,
  });
  layer.on('loading', () => { tileStats = { ok: 0, err: 0 }; });
  layer.on('tileload', () => { tileStats.ok++; });
  layer.on('tileerror', () => { tileStats.err++; });
  layer.on('load', () => {
    if (tileStats.err > 0 && tileStats.err >= tileStats.ok) showVeil('Imagery failed to load. Check your connection.', true);
    else if (!veilIsBlocking) hideVeil();
  });
  layer.addTo(map);
  map.setView([20, 0], 2, { animate: false });
}

let veilIsBlocking = false; // true while a round is being prepared
function showVeil(msg, retry = false, loading = false) {
  el.veilMsg.textContent = msg;
  el.veil.classList.toggle('loading', loading);
  el.veilRetry.hidden = !retry;
  el.veil.hidden = false;
}
function hideVeil() { el.veil.hidden = true; }

el.veilRetry.addEventListener('click', () => {
  if (game.round) {
    tileStats = { ok: 0, err: 0 };
    showVeil('Loading imagery', false, true);
    layer.redraw();
  } else {
    startMode();
  }
});

function renderMapForRound(animate) {
  const r = game.round;
  const misses = r.done ? 0 : r.results.length; // reveal at the tight zoom when the round is over
  const z = C.zoomForMisses(r.answer, misses);
  ensureMap();
  map.invalidateSize();
  desired = { center: [r.answer.lat, r.answer.lon], zoom: z };
  map.setView(desired.center, z, { animate: !!animate });
  el.hint.textContent = r.done ? 'Airfield' : C.HINT_LABELS[Math.min(misses, 4)];
}

function probeImagery(a) {
  return new Promise((resolve) => {
    const t = C.tileCoords(a.lat, a.lon, a.z);
    const img = new Image();
    let finished = false;
    const done = (ok) => { if (!finished) { finished = true; clearTimeout(timer); resolve(ok); } };
    const timer = setTimeout(() => done(false), IMAGERY.probeTimeoutMs);
    img.onload = () => done(img.naturalWidth > 0);
    img.onerror = () => done(false);
    img.src = tileUrl(t.z, t.x, t.y);
  });
}

// ---------- rounds ----------
const keyOf = (mode) => (mode === 'daily' ? C.utcDateString() : null);

async function startMode() {
  const token = ++game.token;
  stopCountdown();
  clearSelection();
  closeList();
  ensureMap();
  game.round = null;
  renderChrome();

  // Resume today's daily from storage (no probing needed: the airport was fixed when first played).
  if (game.mode === 'daily') {
    const date = keyOf('daily');
    const saved = S.loadDaily();
    if (saved && saved.date === date && game.byId.has(saved.id)) {
      const answer = game.byId.get(saved.id);
      const results = [];
      for (const gid of saved.guesses) {
        const g = game.byId.get(gid);
        if (g) results.push(C.evaluateGuess(g, answer));
      }
      game.round = { mode: 'daily', date, answer, results, done: !!saved.done, won: !!saved.won };
      return enterRound(token);
    }
  }

  const order = game.mode === 'daily'
    ? C.dailyOrder(game.airports, keyOf('daily'))
    : C.practiceOrder(game.airports, game.diff).filter((a) => a.id !== game.lastPracticeId);

  veilIsBlocking = true;
  showVeil('Loading imagery', false, true);
  let answer = null;
  for (const cand of order.slice(0, GAME.maxProbeAttempts)) {
    if (await probeImagery(cand)) { answer = cand; break; }
    if (token !== game.token) return;
  }
  if (token !== game.token) return;
  veilIsBlocking = false;
  if (!answer) {
    showVeil('Satellite imagery is unavailable right now. Check your connection and retry.', true);
    return;
  }
  const date = keyOf(game.mode);
  game.round = { mode: game.mode, date, answer, results: [], done: false, won: false };
  if (game.mode === 'daily') persistDaily();
  else game.lastPracticeId = answer.id;
  enterRound(token);
}

function enterRound(token) {
  if (token !== game.token) return;
  veilIsBlocking = false;
  tileStats = { ok: 0, err: 0 };
  showVeil('Loading imagery', false, true);
  renderMapForRound(false);
  renderAll();
  // 'load' will hide the veil; guard in case tiles were already cached and no event fires
  setTimeout(() => { if (token === game.token && tileStats.err === 0) hideVeil(); }, 2500);
}

function persistDaily() {
  const r = game.round;
  S.saveDaily({ date: r.date, id: r.answer.id, guesses: r.results.map((x) => x.id), done: r.done, won: r.won });
}

// ---------- guessing ----------
function submitGuess() {
  const r = game.round;
  const g = game.selected;
  if (!r || r.done || !g) return;
  const res = C.evaluateGuess(g, r.answer);
  r.results.push(res);
  clearSelection();
  closeList();
  if (res.correct) { r.done = true; r.won = true; }
  else if (r.results.length >= C.MAX_GUESSES) { r.done = true; r.won = false; }
  if (r.mode === 'daily') persistDaily();
  if (r.done) S.recordResult(r.mode, r.won, r.results.length, r.date);
  renderMapForRound(true);
  renderAll(true);
  if (r.done) el.result.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  else if (!coarse()) el.input.focus();
}

const coarse = () => window.matchMedia('(pointer: coarse)').matches;

// ---------- rendering ----------
const arrowSvg = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20V4M5.5 10.5 12 4l6.5 6.5"/></svg>';
const fmt = (n) => n.toLocaleString('en-US');
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function renderChrome() {
  for (const b of el.modeSeg.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.mode === game.mode));
  el.diffSeg.hidden = game.mode !== 'practice';
  for (const b of el.diffSeg.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.diff === game.diff));
}

function renderAll(animateLast = false) {
  const r = game.round;
  renderChrome();
  if (!r) return;
  // pips
  el.pips.innerHTML = '';
  for (let i = 0; i < C.MAX_GUESSES; i++) {
    const p = document.createElement('i');
    p.className = 'pip' + (r.results[i] ? (r.results[i].correct ? ' hit' : ' miss') : '');
    el.pips.appendChild(p);
  }
  el.pips.setAttribute('aria-label', `${r.results.length} of ${C.MAX_GUESSES} guesses used`);
  // rows
  el.guesses.innerHTML = '';
  r.results.forEach((res, i) => {
    const g = game.byId.get(res.id);
    const li = document.createElement('li');
    li.className = 'row' + (res.correct ? ' ok' : '');
    if (!(animateLast && i === r.results.length - 1)) li.style.animation = 'none';
    li.innerHTML = `
      <span class="n">${i + 1}</span>
      <div class="who"><span class="nm">${esc(g.name)}</span><span class="code">${esc(g.iata)}</span></div>
      <div class="nums">${res.correct ? '<b>Correct</b>' : `<b>${fmt(res.km)} km</b><span>${res.pct}%</span>`}<span class="bar"><i style="width:${res.pct}%"></i></span></div>
      <div class="dir" aria-label="${res.correct ? 'Correct' : `Answer is ${res.dir} of this airport`}">${arrowSvg}<span>${res.correct ? 'HIT' : res.dir}</span></div>`;
    if (!res.correct) {
      const svg = li.querySelector('svg');
      svg.style.transform = 'rotate(0deg)';
      requestAnimationFrame(() => requestAnimationFrame(() => { svg.style.transform = `rotate(${res.bearing.toFixed(1)}deg)`; }));
    }
    el.guesses.prepend(li); // newest on top
  });
  el.play.hidden = r.done;
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
    <p class="eyebrow">${r.won ? `Solved in ${r.results.length} of ${C.MAX_GUESSES}` : 'Out of guesses'}</p>
    <h2>${esc(a.name)}</h2>
    <p class="codes">${esc(a.iata)} <span>/</span> ${esc(a.icao)}</p>
    <p class="where">${esc(place)}</p>
    <div class="acts">
      <button type="button" class="btn primary" id="btn-share">Share</button>
      ${r.mode === 'practice' ? '<button type="button" class="btn" id="btn-next">Next airport</button>' : ''}
    </div>
    ${r.mode === 'daily' ? '<p class="next">Next airport in <b id="countdown">--:--:--</b></p>' : ''}`;
  $('#btn-share').addEventListener('click', share);
  const next = $('#btn-next');
  if (next) next.addEventListener('click', () => startMode());
  if (r.mode === 'daily') startCountdown();
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
async function share() {
  const r = game.round;
  const title = r.mode === 'daily' ? `Daily ${r.date}` : `Practice · ${C.DIFFICULTIES[game.diff].label}`;
  const url = /^https?:/.test(location.protocol) ? location.origin + location.pathname : '';
  const text = C.buildShareText({ results: r.results, won: r.won, title, url });
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
const hl = (text, q) => {
  // highlight by locating the normalised query in an accent-insensitive way
  const nq = C.normalize(q);
  if (!nq) return esc(text);
  // stripped = accent-free lowercase text; pos[i] = index in `text` that produced stripped[i]
  let stripped = '';
  const pos = [];
  for (let i = 0; i < text.length; i++) {
    const chunk = C.normalize(text[i]).replace(/ /g, '');
    for (const ch of chunk) { stripped += ch; pos.push(i); }
  }
  const idx = stripped.indexOf(nq.replace(/ /g, ''));
  if (idx < 0) return esc(text);
  const start = pos[idx], end = pos[idx + nq.replace(/ /g, '').length - 1] + 1;
  return esc(text.slice(0, start)) + '<mark>' + esc(text.slice(start, end)) + '</mark>' + esc(text.slice(end));
};

function renderList() {
  const q = el.input.value;
  if (game.selected || !q.trim()) return closeList();
  const exclude = new Set(game.round ? game.round.results.map((r) => r.id) : []);
  shown = C.search(game.index, q, { exclude, limit: 6 });
  active = shown.length ? 0 : -1;
  el.list.innerHTML = '';
  if (!shown.length) {
    el.list.innerHTML = '<li class="noresults" role="presentation">No matching airport</li>';
  }
  shown.forEach((a, i) => {
    const li = document.createElement('li');
    li.id = 'opt-' + i;
    li.setAttribute('role', 'option');
    li.setAttribute('aria-selected', String(i === active));
    li.innerHTML = `<span class="s-name">${hl(a.name, q)}</span><span class="s-meta"><b>${esc(a.iata)}</b> &middot; ${esc(a.icao)} &middot; ${esc(a.city ? a.city + ', ' : '')}${esc(a.countryCode)}</span>`;
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
  el.input.value = `${a.name} (${a.iata})`;
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
  const streak = S.displayStreak(st, C.utcDateString());
  const max = Math.max(1, ...m.dist);
  const tiles = [['Played', m.played], ['Win rate', rate + '%']];
  if (statsTab === 'daily') tiles.push(['Streak', streak.current], ['Best', streak.best]);
  else tiles.push(['Wins', m.wins], ['Losses', m.dist[5]]);
  const labels = ['1', '2', '3', '4', '5', 'X'];
  const top = Math.max(...m.dist);
  el.statsBody.innerHTML = `
    <div class="tiles">${tiles.map(([k, v]) => `<div class="tile"><b>${v}</b><span>${k}</span></div>`).join('')}</div>
    <div class="dist"><h3>Guess distribution</h3>
      ${m.dist.map((n, i) => `<div class="drow${n && n === top ? ' top' : ''}"><span>${labels[i]}</span><div class="track"><div class="fill" style="width:${Math.max(n ? 8 : 0, (100 * n) / max)}%">${n || ''}</div></div></div>`).join('')}
    </div>`;
}
$('#btn-stats').addEventListener('click', () => { statsTab = game.mode; renderStats(); el.dlgStats.showModal(); });
el.statsSeg.addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) { statsTab = b.dataset.stats; renderStats(); } });
$('#btn-help').addEventListener('click', () => el.dlgHelp.showModal());
for (const d of [el.dlgHelp, el.dlgStats]) d.addEventListener('click', (e) => { if (e.target === d) d.close(); });

// ---------- mode switching ----------
el.modeSeg.addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b || b.dataset.mode === game.mode) return;
  game.mode = b.dataset.mode; savePrefs(); startMode();
});
el.diffSeg.addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b || b.dataset.diff === game.diff) return;
  game.diff = b.dataset.diff; savePrefs(); startMode();
});

// ---------- viewport / keyboard ----------
// The on-screen keyboard shrinks the visual viewport (iOS) or the layout viewport (Android). Either way, while the
// input is focused and the viewport is much shorter than at rest, switch to a compact layout (smaller map, no chrome)
// so the image, the input and the suggestions all stay on screen.
let restH = 0, restW = 0;
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
  if (map && kb !== was) setTimeout(() => map.invalidateSize(), 320);
}
if (window.visualViewport) window.visualViewport.addEventListener('resize', onViewport);
window.addEventListener('resize', () => { onViewport(); if (map) map.invalidateSize(); });
el.input.addEventListener('blur', () => setTimeout(onViewport, 50));
el.input.addEventListener('focus', () => setTimeout(onViewport, 50));
onViewport();

// ---------- boot ----------
async function boot() {
  loadPrefs();
  renderChrome();
  showVeil('Loading airports', false, true);
  try {
    const res = await fetch('data/airports.json');
    if (!res.ok) throw new Error(res.status);
    const data = await res.json();
    game.airports = data.airports;
  } catch {
    showVeil('Could not load the airport data.', true);
    el.veilRetry.onclick = () => location.reload();
    return;
  }
  for (const a of game.airports) game.byId.set(a.id, a);
  game.index = C.prepareIndex(game.airports);
  if (!S.hasSeenHelp()) { el.dlgHelp.showModal(); S.markHelpSeen(); }
  await startMode();
}

if ('serviceWorker' in navigator && /^https?:/.test(location.protocol)) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
boot();
