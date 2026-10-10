// Non-critical UI, loaded after the first image: Statistics, How to play and About & credits.
// Kept out of the critical path (see js/app.js: loadExtras) so the Daily's image is not delayed by code the player has not asked for.
import { loadData } from './data.js';
export function init({ game, S, C, $, esc, kindOf, todayKey, APP_VERSION }) {
  const dlgHelp = $('#dlg-help'), dlgStats = $('#dlg-stats'), dlgAbout = $('#dlg-about');
  const statsBody = $('#stats-body'), statsSeg = $('#stats-seg');

  // ---- statistics
  let statsTab = 'daily';
  function renderStats() {
    for (const b of statsSeg.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.stats === statsTab));
    const st = S.loadStats();
    const m = st[statsTab];
    const rate = m.played ? Math.round((100 * m.wins) / m.played) : 0;
    const max = Math.max(1, ...m.dist);
    const tiles = [['Played', m.played], ['Win rate', rate + '%']];
    if (statsTab !== 'practice') {
      const streak = S.displayStreak(st, statsTab, todayKey());
      tiles.push(['Streak', streak.current], ['Best', streak.best]);
    } else tiles.push(['Wins', m.wins], ['Losses', m.dist[5]]);
    const labels = ['1', '2', '3', '4', '5', 'X'];
    const top = Math.max(...m.dist);
    statsBody.innerHTML = `
      <div class="tiles">${tiles.map(([k, v]) => `<div class="tile"><b>${v}</b><span>${k}</span></div>`).join('')}</div>
      <div class="dist"><h3>Attempts used</h3>
        ${m.dist.map((n, i) => `<div class="drow${n && n === top ? ' top' : ''}"><span>${labels[i]}</span><div class="track"><div class="fill" style="width:${Math.max(n ? 8 : 0, (100 * n) / max)}%">${n || ''}</div></div></div>`).join('')}
      </div>`;
  }
  statsSeg.addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) { statsTab = b.dataset.stats; renderStats(); } });

  // ---- dialogs close on a backdrop click
  for (const d of [dlgHelp, dlgStats, dlgAbout]) d.addEventListener('click', (e) => { if (e.target === d) d.close(); });

  // ---- about & credits
  let aboutFilled = false;
  async function fillAbout() {
    $('#about-version').textContent = APP_VERSION;
    const date = game.meta && game.meta.ourairports_retrieved;
    $('#about-data-date').textContent = date || 'unknown';
    if (aboutFilled) return;
    try {
      const rank = await loadData('top50');
      $('#about-rank-year').textContent = rank.year;
      $('#about-rank-date').textContent = rank.retrieved;
    } catch { /* the static text stays */ }
    try {
      const c = await loadData('credits');
      $('#oss-list').innerHTML = c.software.map((p) => `<li><a href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.name)}</a> ${esc(p.version)}, ${esc(p.license)} licence. ${esc(p.purpose)}</li>`).join('');
      aboutFilled = true;
    } catch { $('#oss-list').innerHTML = '<li>Open-source software list unavailable offline. See THIRD_PARTY_NOTICES.md in the repository.</li>'; }
  }

  // ---- version history (very bottom of the page): the README changelog, built into data/changelog.json
  const md = (s) => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  async function fillHistory() {
    const box = $('#changelog-list');
    if (!box) return;
    try {
      const { versions } = await loadData('changelog');
      box.innerHTML = versions.map((v, i) => `<details class="ver"${i === 0 ? ' open' : ''}><summary><b>v${esc(v.version)}</b>${v.name ? ` <span>${esc(v.name)}</span>` : ''}${v.date ? ` <time datetime="${esc(v.date)}">${esc(v.date)}</time>` : ''}${i === 0 ? ' <em>current</em>' : ''}</summary><ul>${v.items.map((t) => `<li>${md(t)}</li>`).join('')}</ul></details>`).join('');
    } catch { box.innerHTML = '<p>The version history is unavailable offline.</p>'; }
  }
  fillHistory();

  return {
    openStats() { statsTab = kindOf(); renderStats(); dlgStats.showModal(); },
    openHelp() { dlgHelp.showModal(); },
    openAbout() { fillAbout(); dlgAbout.showModal(); dlgAbout.querySelector('.dlg-body').scrollTop = 0; },
  };
}
