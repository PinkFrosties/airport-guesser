// localStorage persistence. Every access is wrapped in try/catch (private mode, blocked storage...).
import { addDays } from './core.js';

const KEY_STATS = 'airportGuesser.stats.v1';
const KEY_DAILY = { daily: 'airportGuesser.daily.v2', hard: 'airportGuesser.hardDaily.v2' };
const KEY_SEEN = 'airportGuesser.seenHelp.v2';

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

/** Result buckets: dist[0..4] = solved using 1..5 attempts, dist[5] = failed. Modes: daily, hard (Hard daily), practice. */
export const STAT_MODES = ['daily', 'hard', 'practice'];
const emptyMode = () => ({ played: 0, wins: 0, dist: [0, 0, 0, 0, 0, 0] });
const emptyStreak = () => ({ current: 0, best: 0, last: null });

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
  const fixStreak = (st) => ({
    current: Number(st?.current) || 0,
    best: Number(st?.best) || 0,
    last: typeof st?.last === 'string' ? st.last : null,
  });
  return {
    daily: fix(s.daily),
    hard: fix(s.hard),
    practice: fix(s.practice),
    // v1 stored a single `streak` (the Daily one)
    streaks: { daily: fixStreak(s.streaks?.daily ?? s.streak), hard: fixStreak(s.streaks?.hard) },
  };
}

/** Record a finished game. `attempts` = guesses + hints + zoom-outs used (1-5); won = boolean. */
export function recordResult(mode, won, attempts, dateStr) {
  const s = loadStats();
  const m = s[mode];
  m.played += 1;
  if (won) m.wins += 1;
  m.dist[won ? attempts - 1 : 5] += 1;
  const st = s.streaks[mode];
  if (st) {
    if (won) {
      st.current = (st.last === addDays(dateStr, -1) ? st.current : 0) + 1;
      st.best = Math.max(st.best, st.current);
    } else {
      st.current = 0;
    }
    st.last = dateStr;
  }
  write(KEY_STATS, s);
  return s;
}

/** Streak as it should be displayed today (a missed day breaks it). */
export function displayStreak(stats, mode, today) {
  const { current, best, last } = stats.streaks[mode] || emptyStreak();
  const alive = last === today || last === addDays(today, -1);
  return { current: alive ? current : 0, best };
}

/** Saved state of today's Daily for `mode` ('daily' | 'hard'): { date, id, log, done, won }. */
export const loadDaily = (mode) => {
  const d = read(KEY_DAILY[mode]);
  return d && typeof d.date === 'string' && Array.isArray(d.log) ? d : null;
};
export const saveDaily = (mode, d) => write(KEY_DAILY[mode], d);

export const hasSeenHelp = () => read(KEY_SEEN) === true;
export const markHelpSeen = () => write(KEY_SEEN, true);
