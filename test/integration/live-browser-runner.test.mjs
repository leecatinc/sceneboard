import assert from 'node:assert/strict';
import test from 'node:test';

import {
  redactLiveBrowserOutput,
  requireLiveBrowserFixtures,
  runBrowserEngineMatrix,
} from '../../scripts/run-live-browser-tests.mjs';

test('live browser runner fails closed when either fixture URL is absent', () => {
  assert.throws(
    () => requireLiveBrowserFixtures({}),
    /SCENEBOARD_LIVE_BROWSER_FIXTURES_REQUIRED: missing SCENEBOARD_BROWSER_BOARD_URL, SCENEBOARD_BROWSER_PUBLIC_ARTIFACT_URL, SCENEBOARD_BROWSER_STORAGE_STATE/u,
  );
  assert.throws(
    () => requireLiveBrowserFixtures({ SCENEBOARD_BROWSER_BOARD_URL: 'https://board.example' }),
    /missing SCENEBOARD_BROWSER_PUBLIC_ARTIFACT_URL, SCENEBOARD_BROWSER_STORAGE_STATE/u,
  );
});

test('live browser runner accepts complete isolated fixture URLs', () => {
  assert.doesNotThrow(() =>
    requireLiveBrowserFixtures({
      SCENEBOARD_BROWSER_BOARD_URL: 'https://board.example/boards/fixture',
      SCENEBOARD_BROWSER_PUBLIC_ARTIFACT_URL: 'https://board.example/s/fixture-token',
      SCENEBOARD_BROWSER_STORAGE_STATE: '/tmp/sceneboard-browser-storage-state.json',
    }),
  );
});

test('live browser runner rejects credential-bearing or unexpected fixture URLs', () => {
  const valid = {
    SCENEBOARD_BROWSER_BOARD_URL: 'https://board.example/boards/fixture',
    SCENEBOARD_BROWSER_PUBLIC_ARTIFACT_URL: 'https://board.example/s/fixture-token',
    SCENEBOARD_BROWSER_STORAGE_STATE: '/tmp/sceneboard-browser-storage-state.json',
  };
  for (const [name, value] of [
    ['SCENEBOARD_BROWSER_BOARD_URL', 'https://qa-user:qa-pass@board.example/boards/fixture'],
    ['SCENEBOARD_BROWSER_BOARD_URL', 'https://board.example/boards/fixture?token=secret'],
    ['SCENEBOARD_BROWSER_BOARD_URL', 'https://board.example/boards/fixture#secret'],
    ['SCENEBOARD_BROWSER_PUBLIC_ARTIFACT_URL', 'http://board.example/s/fixture-token'],
    ['SCENEBOARD_BROWSER_PUBLIC_ARTIFACT_URL', 'https://board.example/public/fixture-token'],
    ['SCENEBOARD_BROWSER_PUBLIC_ARTIFACT_URL', 'https://board.example/s/fixture-token?key=secret'],
  ])
    assert.throws(() => requireLiveBrowserFixtures({ ...valid, [name]: value }), /_INVALID/u);
});

test('live browser runner records every engine before returning failure', () => {
  const observed = [];
  const failures = runBrowserEngineMatrix(['chromium', 'firefox', 'webkit'], (engine) => {
    observed.push(engine);
    return { status: engine === 'chromium' ? 2 : 0 };
  });
  assert.deepEqual(observed, ['chromium', 'firefox', 'webkit']);
  assert.deepEqual(failures, [{ engine: 'chromium', status: 2 }]);
});

test('live browser runner redacts public share credentials from navigation failures', () => {
  const token = 'share-canary-4af912';
  const querySecret = 'query-canary-9b35';
  const fragmentSecret = 'fragment-canary-71cd';
  const url = `https://board.example/s/${token}?grant=${querySecret}#${fragmentSecret}`;
  const failure = [
    `page.goto: net::ERR_NAME_NOT_RESOLVED at ${url}`,
    `encoded=${encodeURIComponent(url)}`,
    `double=${encodeURIComponent(encodeURIComponent(token))}`,
  ].join('\n');
  const redacted = redactLiveBrowserOutput(failure, url);
  for (const secret of [token, querySecret, fragmentSecret])
    assert.equal(redacted.includes(secret), false);
  assert.match(redacted, /\/s\/<redacted-share-credential>/u);
});

test('live browser output redacts credentials from both fixture URLs', () => {
  const boardUrl =
    'https://board-user:board-pass@board.example/boards/fixture?grant=board-query#board-fragment';
  const publicUrl = 'https://share-user:share-pass@board.example/s/share-token';
  const redacted = redactLiveBrowserOutput(`${boardUrl}\n${publicUrl}`, [boardUrl, publicUrl]);
  for (const secret of [
    'board-user',
    'board-pass',
    'board-query',
    'board-fragment',
    'share-user',
    'share-pass',
    'share-token',
  ])
    assert.equal(redacted.includes(secret), false);
});

test('matrix-owned browser specs do not launch a hard-coded engine', async () => {
  const { readFile, readdir } = await import('node:fs/promises');
  const directory = new URL('../../test/browser/', import.meta.url);
  const specifications = (await readdir(directory)).filter((name) => name.endsWith('.spec.ts'));
  for (const name of specifications) {
    const source = await readFile(new URL(name, directory), 'utf8');
    assert.doesNotMatch(
      source,
      /import\s*\{[^}]*\b(?:chromium|firefox|webkit)\b[^}]*\}\s*from\s*['"]playwright['"]/u,
      name,
    );
    assert.doesNotMatch(source, /\b(?:chromium|firefox|webkit)\.launch\s*\(/u, name);
  }
});
