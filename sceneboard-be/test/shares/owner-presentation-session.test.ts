import assert from 'node:assert/strict';
import test from 'node:test';

import type { BoardId, PageId, RevisionId } from '@sceneboard/board-schema';

import { ShareContractError } from '../../src/common/errors/app-error.js';
import { OwnerPresentationSessionService } from '../../src/shares/owner-presentation-session.service.js';

const boardId = 'board_1234567890123456789012' as BoardId;
const revisionId = '12345678-1234-4123-8123-123456789012' as RevisionId;
const pageId = 'page_1234567890123456789012' as PageId;

const principal = {
  kind: 'user',
  userPk: 7n,
  sessionPk: 8n,
  familyPublicId: 'family',
  isBrowserCredential: true,
  actor: {},
} as never;

const makeService = (input: {
  accessKind?: 'owner' | 'editor';
  share: null | Record<string, unknown>;
}) => {
  const connection = {
    execute: async (sql: string) => {
      if (sql === 'SELECT UTC_TIMESTAMP(3) AS nowSql')
        return [[{ nowSql: '2026-08-06 00:00:00.000' }]];
      throw new TypeError(`unexpected query: ${sql}`);
    },
  };
  const accessPolicy = {
    withAuthorizedBoardTransaction: async (
      request: { operation: string },
      apply: (database: unknown, context: unknown) => Promise<unknown>,
    ) => {
      assert.equal(request.operation, 'share.list');
      return apply(connection, {
        access: { kind: input.accessKind ?? 'owner' },
        membership: { boardPk: 22n },
      });
    },
  };
  const projections = {
    readOwnerPageIds: async () => ({ revisionPk: 33n, pageIds: new Set([pageId]) }),
  };
  const shares = { readShare: async () => input.share };
  return new OwnerPresentationSessionService(
    accessPolicy as never,
    shares as never,
    projections as never,
    {} as never,
  );
};

test('owner presentation authorizes an unpublished revision in an owner-only room', async () => {
  const service = makeService({ share: null });
  const authorized = await service.authorize({ principal, boardId, revisionId });
  assert.deepEqual(authorized.room, {
    sharePk: 0n,
    boardPk: 22n,
    revisionPk: 33n,
    publicationGeneration: 1,
    accessGeneration: 1,
  });
  assert.deepEqual([...authorized.pageIds], [pageId]);
});

test('owner presentation reuses the public room only for the active pinned revision', async () => {
  const activeShare = {
    status: 'active',
    pinnedRevisionId: revisionId,
    sharePk: 44n,
    boardPk: 22n,
    pinnedRevisionPk: 33n,
    publicationGeneration: 5,
    accessGeneration: 6,
  };
  const service = makeService({ share: activeShare });
  const authorized = await service.authorize({ principal, boardId, revisionId });
  assert.deepEqual(authorized.room, {
    sharePk: 44n,
    boardPk: 22n,
    revisionPk: 33n,
    publicationGeneration: 5,
    accessGeneration: 6,
  });
});

test('owner presentation keeps owner authorization when no public share is required', async () => {
  const service = makeService({ accessKind: 'editor', share: null });
  await assert.rejects(
    () => service.authorize({ principal, boardId, revisionId }),
    (error: unknown) => error instanceof ShareContractError && error.code === 'BOARD_NOT_FOUND',
  );
});
