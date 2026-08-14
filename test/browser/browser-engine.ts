import { chromium, firefox, webkit, type BrowserType } from 'playwright';

const engines = { chromium, firefox, webkit } satisfies Record<string, BrowserType>;

export type BrowserEngineName = keyof typeof engines;

export const browserEngineName = (process.env.SCENEBOARD_BROWSER_ENGINE ??
  'chromium') as BrowserEngineName;

if (!(browserEngineName in engines)) {
  throw new TypeError(`SCENEBOARD_BROWSER_ENGINE_UNSUPPORTED: ${browserEngineName}`);
}

export const launchBrowser = () => engines[browserEngineName].launch({ headless: true });
