// Browser selection for the Playwright tests: AG_BROWSER=chromium (default, Edge/Chrome channel when available) | firefox | webkit
import { chromium, firefox, webkit } from 'playwright';
export const browserName = process.env.AG_BROWSER || 'chromium';
export const launchBrowser = (opts = {}) => ({ chromium, firefox, webkit }[browserName]).launch(browserName === 'chromium' ? opts : {});
