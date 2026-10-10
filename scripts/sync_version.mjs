// Writes the version from js/version.js (the single source of truth) into package.json and the service worker.
// Usage: node scripts/sync_version.mjs        (run after changing js/version.js; tests/changelog.mjs checks the result)
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const file = (p) => join(root, p);
const version = readFileSync(file('js/version.js'), 'utf8').match(/APP_VERSION = '(\d+\.\d+\.\d+)'/)?.[1];
if (!version) throw new Error('js/version.js has no APP_VERSION = \'x.y.z\'');

const pkg = readFileSync(file('package.json'), 'utf8');
writeFileSync(file('package.json'), pkg.replace(/"version":\s*"[^"]+"/, `"version":"${version}"`));

const sw = readFileSync(file('sw.js'), 'utf8');
if (!/const VERSION = '[^']+';/.test(sw)) throw new Error('sw.js has no VERSION constant');
writeFileSync(file('sw.js'), sw.replace(/const VERSION = '[^']+';/, `const VERSION = '${version}';`));

console.log('version', version, '-> package.json, sw.js');
