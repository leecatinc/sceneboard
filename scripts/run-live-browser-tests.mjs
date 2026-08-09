import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const REQUIRED_FIXTURES = [
  'SCENEBOARD_BROWSER_BOARD_URL',
  'SCENEBOARD_BROWSER_PUBLIC_ARTIFACT_URL',
];

export const requireLiveBrowserFixtures = (environment = process.env) => {
  const missing = REQUIRED_FIXTURES.filter((name) => {
    const value = environment[name];
    return value === undefined || value.trim().length === 0;
  });
  if (missing.length > 0) {
    throw new TypeError(`SCENEBOARD_LIVE_BROWSER_FIXTURES_REQUIRED: missing ${missing.join(', ')}`);
  }
};

const run = () => {
  requireLiveBrowserFixtures();
  const tsxCli = resolve(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const browserTestDirectory = resolve(process.cwd(), 'test', 'browser');
  const browserTests = readdirSync(browserTestDirectory)
    .filter((name) => name.endsWith('.spec.ts'))
    .sort()
    .map((name) => resolve(browserTestDirectory, name));
  const result = spawnSync(process.execPath, [tsxCli, '--test', ...browserTests], {
    cwd: process.cwd(),
    env: process.env,
    stdio: 'inherit',
  });
  if (result.error !== undefined) throw result.error;
  process.exitCode = result.status ?? 1;
};

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) run();
