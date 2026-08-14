import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const REQUIRED_FIXTURES = [
  'SCENEBOARD_BROWSER_BOARD_URL',
  'SCENEBOARD_BROWSER_PUBLIC_ARTIFACT_URL',
  'SCENEBOARD_BROWSER_STORAGE_STATE',
];

const SUPPORTED_ENGINES = ['chromium', 'firefox', 'webkit'];

const escapeRegularExpression = (value) => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

const parseFixtureUrl = (name, value, expectedPath) => {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError(`${name}_INVALID`);
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    !expectedPath.test(parsed.pathname)
  )
    throw new TypeError(`${name}_INVALID`);
  return parsed;
};

export const redactLiveBrowserOutput = (value, fixtureUrls) => {
  let output = String(value ?? '');
  const replacements = [];
  for (const fixtureUrl of Array.isArray(fixtureUrls) ? fixtureUrls : [fixtureUrls]) {
    let parsed;
    try {
      parsed = new URL(fixtureUrl);
    } catch {
      throw new TypeError('SCENEBOARD_BROWSER_FIXTURE_URL_INVALID');
    }
    const shareMatch = parsed.pathname.match(/\/s\/([^/?#]+)/u);
    if (shareMatch?.[1]) replacements.push([shareMatch[1], '<redacted-share-credential>']);
    if (parsed.username) replacements.push([parsed.username, '<redacted-username>']);
    if (parsed.password) replacements.push([parsed.password, '<redacted-password>']);
    for (const parameterValue of parsed.searchParams.values())
      if (parameterValue) replacements.push([parameterValue, '<redacted-query-value>']);
    if (parsed.hash.length > 1) replacements.push([parsed.hash.slice(1), '<redacted-fragment>']);
  }
  for (const [secret, redacted] of replacements) {
    for (const candidate of [
      secret,
      encodeURIComponent(secret),
      encodeURIComponent(encodeURIComponent(secret)),
    ])
      output = output.replace(new RegExp(escapeRegularExpression(candidate), 'giu'), redacted);
  }
  return output
    .replace(/\/s\/[^/?#\s)'"`]+/giu, '/s/<redacted-share-credential>')
    .replace(/%2fs%2f[^%\s)'"`]+/giu, '%2Fs%2F<redacted-share-credential>');
};

export const requireLiveBrowserFixtures = (environment = process.env) => {
  const missing = REQUIRED_FIXTURES.filter((name) => {
    const value = environment[name];
    return value === undefined || value.trim().length === 0;
  });
  if (missing.length > 0) {
    throw new TypeError(`SCENEBOARD_LIVE_BROWSER_FIXTURES_REQUIRED: missing ${missing.join(', ')}`);
  }
  parseFixtureUrl(
    'SCENEBOARD_BROWSER_BOARD_URL',
    environment.SCENEBOARD_BROWSER_BOARD_URL,
    /^\/boards\/[^/]+$/u,
  );
  parseFixtureUrl(
    'SCENEBOARD_BROWSER_PUBLIC_ARTIFACT_URL',
    environment.SCENEBOARD_BROWSER_PUBLIC_ARTIFACT_URL,
    /^\/s\/[^/]+$/u,
  );
};

export const runBrowserEngineMatrix = (engines, execute) => {
  const failures = [];
  for (const engine of engines) {
    const result = execute(engine);
    if (result.error !== undefined) throw result.error;
    if ((result.status ?? 1) !== 0) failures.push({ engine, status: result.status ?? 1 });
  }
  return failures;
};

const run = () => {
  requireLiveBrowserFixtures();
  const tsxCli = resolve(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const browserTestDirectory = resolve(process.cwd(), 'test', 'browser');
  const browserTests = readdirSync(browserTestDirectory)
    .filter((name) => name.endsWith('.spec.ts'))
    .sort()
    .map((name) => resolve(browserTestDirectory, name));
  const configuredEngines = process.env.SCENEBOARD_BROWSER_ENGINES?.split(',')
    .map((engine) => engine.trim())
    .filter(Boolean);
  const engines = configuredEngines?.length ? configuredEngines : SUPPORTED_ENGINES;
  const unsupported = engines.filter((engine) => !SUPPORTED_ENGINES.includes(engine));
  if (unsupported.length > 0) {
    throw new TypeError(`SCENEBOARD_BROWSER_ENGINES_UNSUPPORTED: ${unsupported.join(', ')}`);
  }
  const failures = runBrowserEngineMatrix(engines, (engine) => {
    process.stdout.write(`\n[sceneboard-live-browser] engine=${engine}\n`);
    const result = spawnSync(
      process.execPath,
      [tsxCli, '--test', '--test-concurrency=1', ...browserTests],
      {
        cwd: process.cwd(),
        env: { ...process.env, SCENEBOARD_BROWSER_ENGINE: engine },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 64 * 1024 * 1024,
      },
    );
    const fixtureUrls = [
      process.env.SCENEBOARD_BROWSER_BOARD_URL,
      process.env.SCENEBOARD_BROWSER_PUBLIC_ARTIFACT_URL,
    ];
    process.stdout.write(redactLiveBrowserOutput(result.stdout, fixtureUrls));
    process.stderr.write(redactLiveBrowserOutput(result.stderr, fixtureUrls));
    return result;
  });
  if (failures.length > 0) {
    process.stdout.write(
      `\n[sceneboard-live-browser] failed engines: ${failures
        .map(({ engine, status }) => `${engine}(${status})`)
        .join(', ')}\n`,
    );
    process.exitCode = 1;
  }
};

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) run();
