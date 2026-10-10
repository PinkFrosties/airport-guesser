// Runs every test script and prints one line each.  Usage: node tests/all.mjs [--dist] [--webkit]
//   (default: source tree on Chromium; --dist tests the built site, --webkit uses Playwright's WebKit)
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
const args = process.argv.slice(2);
const env = { ...process.env };
if (args.includes('--dist')) env.AG_ROOT = 'dist';
if (args.includes('--webkit')) env.AG_BROWSER = 'webkit';
const scripts = ['unit', 'unit.game', 'changelog', 'credits', 'theme', 'zoomfit', 'targets', 'textscale', 'hardening', 'typing', 'direction', 'hints', 'zoominteract', 'wikipedia', 'e2e'];
let bad = 0;
for (const s of scripts) {
  const file = new URL(`./${s}.mjs`, import.meta.url);
  if (!existsSync(file)) continue;
  const r = spawnSync(process.execPath, [file.pathname.replace(/^\/([A-Za-z]:)/, '$1')], { env, encoding: 'utf8', timeout: 1_200_000 });
  const out = (r.stdout || '') + (r.stderr || '');
  const fails = (out.match(/^\s*FAIL /gm) || []).length;
  const last = out.trim().split('\n').filter((l) => /passed|failed|FAILED|clean|same zoom|Error/i.test(l)).pop() || out.trim().split('\n').pop() || '';
  const ok = r.status === 0 && !fails;
  if (!ok) bad++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${s.padEnd(13)} ${last.trim().slice(0, 130)}`);
  if (!ok) console.log(out.split('\n').filter((l) => /FAIL|Error|expected|!==/.test(l)).slice(0, 6).join('\n'));
}
console.log(bad ? `${bad} script(s) FAILED` : 'all scripts passed');
process.exit(bad ? 1 : 0);
