// The ONE source of truth for the app version. Everything else is derived from it:
//  - footer and About & credits read it at runtime (js/app.js)
//  - package.json and the service worker cache name are written by `node scripts/sync_version.mjs`
//  - tests/changelog.mjs fails if any of them, or the top README changelog entry, disagree
export const APP_VERSION = '1.4.1';
