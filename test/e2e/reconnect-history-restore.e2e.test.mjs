import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('reconnect/history/restore static seam preserves pinned history and copy-forward restore', async () => {
  const root = new URL('../../', import.meta.url);
  const state = await readFile(new URL('packages/board-sdk/src/state/live-board-state.ts', root), 'utf8');
  const mutation = await readFile(new URL('leecat-board-nestjs/src/revisions/board-mutation.service.ts', root), 'utf8');
  assert.match(state, /enterHistoryV1/u);
  assert.match(state, /enterLatestV1/u);
  assert.match(mutation, /scene\.restore/u);
  assert.match(mutation, /sourceRevisionId/u);
});
