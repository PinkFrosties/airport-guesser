// Turns the README changelog (the single place it is written) into data/changelog.json, which the page shows at the very bottom
// ("Version history"). Run by sync_version.mjs and by the site build; tests/changelog.mjs checks the file is current.
// Usage: node scripts/gen_changelog.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

export function parseChangelog(readme) {
  const section = readme.split('## Changelog')[1].split(/\n## /)[0];
  const versions = [];
  for (const block of section.split(/^### /m).slice(1)) {
    const [head, ...lines] = block.split(/\r?\n/);
    const m = head.match(/^v(\d+\.\d+(?:\.\d+)?)\s*(?:\(([^)]*)\))?\s*(?:-\s*(\d{4}-\d{2}-\d{2}))?/);
    if (!m) continue;
    const items = [];
    for (const l of lines) {
      if (l.startsWith('- ')) items.push(l.slice(2).trim());
      else if (items.length && /^\s+\S/.test(l)) items[items.length - 1] += ' ' + l.trim(); // wrapped bullet
    }
    versions.push({ version: m[1], name: m[2] || '', date: m[3] || '', items });
  }
  return { versions };
}

export function writeChangelog() {
  const out = parseChangelog(readFileSync(join(root, 'README.md'), 'utf8'));
  writeFileSync(join(root, 'data/changelog.json'), JSON.stringify(out) + '\n');
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const out = writeChangelog();
  console.log(`wrote data/changelog.json: ${out.versions.length} versions, newest v${out.versions[0].version}`);
}
