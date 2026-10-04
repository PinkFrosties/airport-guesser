// localStorage persistence. Every access is wrapped in try/catch (private mode, blocked storage...).
import { addDays } from './core.js';

const KEY_STATS = 'airportGuesser.stats.v1';
const KEY_DAILY = 'airportGuesser.daily.v1';
const KEY_SEEN = 'airportGuesser.seenHelp.v1';

function read(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

const emptyMode = () => ({ played: 0, wins: 0, dist: [0, 0, 0, 0, 0, 0] }); // dist[0..4] = win in 1..5, dist[5] = loss

export function loadStats() {
  const s = read(KEY_STATS) || {};
  const fix = (m) => {
    const out = emptyMode();
    if (m && typeof m === 'object') {
      out.played = Number(m.played) || 0;
      out.wins = Number(m.wins) || 0;
      if (Array.isArray(m.dist)) out.dist = out.dist.map((_, i) => Number(m.dist[i]) || 0);
    }
    return out;
  };
  const st = s.streak || {};
  return {
    daily: fix(s.daily),
    practice: fix(s.practice),
    streak: { current: Number(st.current) || 0, best: Number(st.best) || 0, last: typeof st.last === 'string' ? st.last : null },
  };
}

/** Record a finished game. `guesses` = number of guesses used (1-5); won = boolean. */
export function recordResult(mode, won, guesses, dateStr) {
  const s = loadStats();
  const m = s[mode];
  m.played += 1;
  if (won) m.wins += 1;
  m.dist[won ? guesses - 1 : 5] += 1;
  if (mode === 'daily') {
    if (won) {
      s.streak.current = (s.streak.last === addDays(dateStr, -1) ? s.streak.current : 0) + 1;
      s.streak.best = Math.max(s.streak.best, s.streak.current);
    } else {
      s.streak.current = 0;
    }
    s.streak.last = dateStr;
  }
  write(KEY_STATS, s);
  return s;
}

/** Streak as it should be displayed today (a missed day breaks it). */
export function displayStreak(stats, today) {
  const { current, best, last } = stats.streak;
  const alive = last === today || last === addDays(today, -1);
  return { current: alive ? current : 0, best };
}

export const loadDaily = () => {
  const d = read(KEY_DAILY);
  return d && typeof d.date === 'string' && Array.isArray(d.guesses) ? d : null;
};
export const saveDaily = (d) => write(KEY_DAILY, d);

export const hasSeenHelp = () => read(KEY_SEEN) === true;
export const markHelpSeen = () => write(KEY_SEEN, true);
