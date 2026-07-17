import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  BoardOperationRequestParserV1,
  BoardOperationResultParserV1,
  normalizeActorContextV1,
  type ActorContextV1,
  type BoardId,
} from '@leecat-board/board-schema';
import type { PoolConnection, ResultSetHeader } from 'mysql2/promise';

import { BoardArchiveService, type BoardArchiveRequestV1 } from '../../src/boards/board-archive.service.js';
import { BoardContractError } from '../../src/common/errors/app-error.js';
import type {
  AuthorizedBoardContextV1,
  AuthorizedBoardTransactionInputV1,
  BoardAccessPolicy,
  ResolvedBoardPrincipalV1,
} from '../../src/grants/board-access.policy.js';

const boardId = 'AAECAwQFBgcICQoLDA0ODw' as BoardId;
const revisionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const actor = (): ActorContextV1 => {
  const parsed = normalizeActorContextV1({
    principalKind: 'user', principalId: 'user_1', grantId: null,
    scopes: ['board.history.read', 'board.read', 'board.write'],
  });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) throw new Error('invalid actor fixture');
  return parsed.data.value;
};

const principal = (): Extract<ResolvedBoardPrincipalV1, { kind: 'user' }> => ({
  kind: 'user', actor: actor(), userPk: 20n, sessionPk: 21n, familyPublicId: 'family_1',
});

const request = (requestId: string): BoardArchiveRequestV1 => {
  const parsed = BoardOperationRequestParserV1.parse({
    protocolVersion: 1, requestId, type: 'board.archive',
    idempotencyKey: 'archive-board-key-0001', boardId, confirm: true,
  });
  assert.equal(parsed.ok, true);
  if (!parsed.ok || parsed.data.value.type !== 'board.archive') throw new Error('invalid request fixture');
  return parsed.data.value as BoardArchiveRequestV1;
};

const setup = (alreadyArchived = false) => {
  const calls: string[] = [];
  let stored: Record<string, unknown> | null = null;
  let archiveWrites = 0;
  const connection = {
    async execute(sql: string, binds: unknown[] = []): Promise<[unknown, unknown]> {
      const normalized = sql.replace(/\s+/g, ' ').trim();
      calls.push(normalized);
      if (normalized.startsWith('INSERT INTO board_idempotency_records')) {
        if (stored !== null) return [{ affectedRows: 0, insertId: 60 } as ResultSetHeader, []];
        stored = {
          statusCode: 'P', operationType: 'board.archive', fingerprintSha256: binds[7],
          actorGrantId: binds[8], actorScopesSha256: binds[10],
          resultPayload: null, resultCanonicalBytes: null, resultSha256: null,
          resultBoardPk: null, resultRevisionPk: null,
        };
        return [{ affectedRows: 1, insertId: 60 } as ResultSetHeader, []];
      }
      if (normalized.includes('FROM board_idempotency_records')) return [[stored], []];
      if (normalized.includes('FROM boards b') && normalized.endsWith('FOR UPDATE')) {
        return [[{
          boardPk: '50', boardId, title: 'Archived scene',
          boardCreatedAt: '2026-07-16 11:00:00.000',
          boardUpdatedAt: '2026-07-16 11:30:00.000',
          archivedAt: alreadyArchived ? '2026-07-16 11:45:00.000' : null,
          headRevisionPk: '70', revisionId,
          headRevisionId: Buffer.from(revisionId.replaceAll('-', ''), 'hex'),
          headRevisionNumber: '2',
          headRevisionCreatedAt: '2026-07-16 11:30:00.000',
        }], []];
      }
      if (normalized.startsWith('UPDATE boards')) {
        archiveWrites += 1;
        return [{ affectedRows: 1, insertId: 0 } as ResultSetHeader, []];
      }
      if (normalized.startsWith('UPDATE board_idempotency_records')) {
        assert.ok(stored);
        stored = {
          ...stored, statusCode: 'C', resultPayload: binds[0], resultCanonicalBytes: binds[1],
          resultSha256: binds[2], resultBoardPk: String(binds[3]), resultRevisionPk: String(binds[4]),
        };
        return [{ affectedRows: 1, insertId: 0 } as ResultSetHeader, []];
      }
      if (normalized.includes('FROM boards b') && normalized.includes('JOIN board_revisions r')) {
        return [[{
          boardId,
          revisionId: Buffer.from(revisionId.replaceAll('-', ''), 'hex'),
        }], []];
      }
      throw new Error(`unexpected SQL: ${normalized}`);
    },
  } as unknown as PoolConnection;
  const context: AuthorizedBoardContextV1 = {
    actor: actor(), ownerUserPk: 20n, access: { kind: 'owner', ownerUserPk: 20n },
    createBinding: null,
    artifactCapabilityPolicy: { allowedArtifactRequestCapabilities: [], policyEpoch: 'AAAAAAAAAAAAAAAAAAAAAA' },
  };
  const policy: BoardAccessPolicy = {
    async withAuthorizedBoardTransaction<T>(
      input: AuthorizedBoardTransactionInputV1,
      apply: (value: PoolConnection, authorized: AuthorizedBoardContextV1) => Promise<T>,
    ) {
      assert.equal(input.operation, 'board.archive');
      assert.equal(input.isolation, 'READ_COMMITTED_WRITE');
      const before = stored;
      try {
        return await apply(connection, context);
      } catch (error) {
        stored = before;
        throw error;
      }
    },
  };
  return {
    calls,
    archiveWrites: () => archiveWrites,
    service: new BoardArchiveService(policy, {
      now: () => new Date('2026-07-16T12:00:00.000Z'),
      generateUuid: () => '00112233-4455-4677-8899-aabbccddeeff',
    }),
  };
};

test('archives without changing the non-null head and replays without a second write or event', async () => {
  const value = setup();
  const first = await value.service.archive({ principal: principal(), request: request('request_archive_1') });
  assert.equal(BoardOperationResultParserV1.parse(first).ok, true);
  assert.equal(first.result.type, 'board.archive');
  if (first.result.type !== 'board.archive') return;
  assert.equal(first.result.board.archivedAt, '2026-07-16T12:00:00.000Z');
  assert.equal(first.result.board.headRevision.revisionId, revisionId);
  const replay = await value.service.archive({ principal: principal(), request: request('request_archive_2') });
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.result, first.result);
  assert.equal(value.archiveWrites(), 1);
  assert.equal(value.calls.some((call) => call.includes('board_event_outbox')), false);
});

test('a new archive attempt against an archived locked board fails without mutation', async () => {
  const value = setup(true);
  await assert.rejects(
    value.service.archive({ principal: principal(), request: request('request_archive_1') }),
    (error: unknown) => error instanceof BoardContractError
      && error.boardError.code === 'BOARD_ALREADY_ARCHIVED'
      && error.boardError.details?.archivedAt === '2026-07-16T11:45:00.000Z',
  );
  assert.equal(value.archiveWrites(), 0);
});
