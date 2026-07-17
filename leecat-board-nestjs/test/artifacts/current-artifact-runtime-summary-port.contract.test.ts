import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { PoolConnection } from 'mysql2/promise';

import { CurrentArtifactRuntimeSummaryProvider } from '../../src/artifacts/current-artifact-runtime-summary.provider.js';

test('returns no rows and performs no query for a snapshot without artifact references', async () => {
  let queries = 0;
  const connection = {
    execute: async () => {
      queries += 1;
      return [[], []];
    },
  } as unknown as PoolConnection;
  const result = await new CurrentArtifactRuntimeSummaryProvider().readAuthorizedAtCut(connection, {
    actor: { principalKind: 'user', principalId: 'user_1', grantId: null, scopes: ['board.read'] },
    boardId: 'board_1',
    revision: {
      revisionId: 'revision_1', revisionNumber: 1, createdAt: '2026-07-17T00:00:00.000Z',
      previousRevisionId: null, originType: 'board.create', sourceRevisionId: null,
      actor: { principalKind: 'user', principalId: 'user_1' },
    },
    scene: { protocolVersion: 1, type: 'scene', root: null },
    lastEventSequence: 1,
  } as never);
  assert.deepEqual(result, []);
  assert.equal(queries, 0);
});
