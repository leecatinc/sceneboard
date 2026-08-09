import assert from 'node:assert/strict';
import test from 'node:test';

import { requireLiveBrowserFixtures } from '../../scripts/run-live-browser-tests.mjs';

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
      SCENEBOARD_BROWSER_PUBLIC_ARTIFACT_URL: 'https://board.example/public/artifacts/fixture',
      SCENEBOARD_BROWSER_STORAGE_STATE: '/tmp/sceneboard-browser-storage-state.json',
    }),
  );
});
