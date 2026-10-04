// Theme: System (default) / Light / Dark. The choice is stored in localStorage; "System" follows the OS live.
// The first paint is handled by the inline script in index.html <head>; this module keeps things in sync afterwards.
const KEY = 'airportGuesser.theme.v1';
export const THEME_COLOR = { light: '#f5f5f7', dark: '#000000' }; // matches --bg of each theme (browser bar on phones)
let memory = null; // used only if localStorage is blocked
const query = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

export function getPref() {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return memory || 'system';
  }
}

export const resolve = (pref) => (pref === 'system' ? (query && query.matches ? 'dark' : 'light') : pref);

/** Apply the stored preference to <html> and the browser-bar colour. */
export function apply() {
  const pref = getPref();
  const theme = resolve(pref);
  const root = document.documentElement;
  root.setAttribute('data-theme', theme);
  root.setAttribute('data-theme-pref', pref);
  root.style.colorScheme = theme;
  root.style.backgroundColor = ''; // drop the pre-paint stopgap from the inline script; tokens take over
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', THEME_COLOR[theme]);
  return { pref, theme };
}

export function setPref(pref) {
  try {
    if (pref === 'system') localStorage.removeItem(KEY); else localStorage.setItem(KEY, pref);
  } catch { /* storage unavailable: the choice lasts for this page view only */ }
  memory = pref === 'system' ? null : pref;
  return apply();
}

/** Wire up live updates: OS setting changes (when on System) and changes from another tab. */
export function initTheme(onChange) {
  const notify = () => onChange && onChange(apply());
  if (query) {
    const handler = () => { if (getPref() === 'system') notify(); };
    if (query.addEventListener) query.addEventListener('change', handler); else query.addListener(handler);
  }
  window.addEventListener('storage', (e) => { if (e.key === KEY) notify(); });
  notify();
}
