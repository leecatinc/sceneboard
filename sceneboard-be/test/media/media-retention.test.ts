import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BoardPersistenceError } from '../../src/common/errors/board-persistence.error.js';
import { MediaRetentionService } from '../../src/media/media-retention.service.js';

test('retention refuses to detach media refs while any strong revision hold is active', async () => {
  const calls: string[] = [];
  const connection = {
    execute: async (sql: string) => {
      const normalized = sql.replace(/\s+/gu, ' ').trim();
      calls.push(normalized);
      if (normalized.includes('FROM board_revision_media_refs')) return [[{ ordinal: 0 }]];
      if (normalized.includes('FROM board_revision_holds'))
        return [[{ kind: 'publication', holder_id: 'share_1' }]];
      throw new Error(`unexpected SQL: ${normalized}`);
    },
  };
  await assert.rejects(
    new MediaRetentionService().reconcileRetentionItem(connection as never, {
      boardPk: '3',
      revisionPk: '7',
      runId: 'run_1',
      fence: 1n,
    }),
    BoardPersistenceError,
  );
  assert.equal(calls.length, 2);
});

test('retention admits exact media-ref detach only after the hold position is empty', async () => {
  const connection = {
    execute: async (sql: string) =>
      sql.includes('board_revision_media_refs') ? [[{ ordinal: 0 }]] : [[]],
  };
  await new MediaRetentionService().reconcileRetentionItem(connection as never, {
    boardPk: '3',
    revisionPk: '7',
    runId: 'run_1',
    fence: 1n,
  });
});

test('publication handoff locks media refs in ascending revision order on the caller connection', async () => {
  const revisions: string[] = [];
  const connection = {
    execute: async (_sql: string, values: readonly unknown[]) => {
      revisions.push(String(values[1]));
      return [[]];
    },
  };
  await new MediaRetentionService().applyPublicationTransition(connection as never, {
    sharePk: 2n,
    oldRevisionPk: 9n,
    newRevisionPk: 4n,
    publicationGeneration: 3,
    recoveryId: 'recovery_1',
  });
  assert.deepEqual(revisions, ['4', '9']);
});
