import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  BoardOperationRequestParserV1,
  BoardOperationResultParserV1,
  normalizeActorContextV1,
  type ActorContextV1,
  type BoardId,
  type GrantId,
} from '@sceneboard/board-schema';
import type { PoolConnection, ResultSetHeader } from 'mysql2/promise';

import { BoardCreateService } from '../../src/boards/board-create.service.js';
import { DocumentCheckpointCodec } from '../../src/revisions/document-checkpoint.codec.js';
import type {
  AuthorizedBoardContextV1,
  AuthorizedBoardTransactionInputV1,
  BoardAccessPolicy,
  ResolvedBoardPrincipalV1,
} from '../../src/grants/board-access.policy.js';
import type { CryptoService } from '../../src/common/security/crypto.service.js';
import { BoardContractError } from '../../src/common/errors/app-error.js';

type CreateRequest = Parameters<BoardCreateService['create']>[0]['request'];

const parseCreate = (requestId: string, title = 'First scene'): CreateRequest => {
  const result = BoardOperationRequestParserV1.parse({
    protocolVersion: 1,
    requestId,
    type: 'board.create',
    idempotencyKey: 'create-board-key-0001',
    title,
  });
  assert.equal(result.ok, true);
  if (!result.ok || result.data.value.type !== 'board.create')
    throw new Error('invalid request fixture');
  return result.data.value as CreateRequest;
};

const parseActor = (value: unknown): ActorContextV1 => {
  const result = normalizeActorContextV1(value);
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error('invalid actor fixture');
  return result.data.value;
};

const userPrincipal = (): Extract<ResolvedBoardPrincipalV1, { kind: 'user' }> => ({
  kind: 'user',
  actor: parseActor({
    principalKind: 'user',
    principalId: 'user_1',
    grantId: null,
    scopes: ['board.read', 'board.write'],
  }),
  userPk: 20n,
  sessionPk: 21n,
  familyPublicId: 'family_1',
});

const mcpPrincipal = (): Extract<ResolvedBoardPrincipalV1, { kind: 'mcp' }> => ({
  kind: 'mcp',
  actor: parseActor({
    principalKind: 'mcp_client',
    principalId: 'client_1',
    grantId: 'grant_1',
    scopes: ['board.read', 'board.write'],
  }),
  ownerUserPk: 20n,
  grantPk: 30n,
  credentialPk: 40n,
  grantId: 'grant_1' as GrantId,
  sourceFamilyPublicId: null,
});

interface SetupOptions {
  mcp?: boolean;
  boardCollisionOnce?: boolean;
}

const setup = (options: SetupOptions = {}) => {
  const calls: string[] = [];
  const insertedBoardIds: string[] = [];
  let stored: Record<string, unknown> | null = null;
  let boardCollisionPending = options.boardCollisionOnce === true;
  const connection = {
    async execute(sql: string, binds: unknown[] = []): Promise<[unknown, unknown]> {
      const normalized = sql.replace(/\s+/g, ' ').trim();
      calls.push(normalized);
      if (normalized.startsWith('INSERT INTO board_idempotency_records')) {
        if (stored !== null) return [{ affectedRows: 0, insertId: 60 } as ResultSetHeader, []];
        stored = {
          recordPk: '60',
          statusCode: 'P',
          operationType: 'board.create',
          fingerprintSha256: binds[6],
          actorGrantId: binds[7],
          actorScopesSha256: binds[9],
          commandPayloadSha256: binds[10],
          resultPayload: null,
          resultCanonicalBytes: null,
          resultSha256: null,
          resultBoardPk: null,
          resultRevisionPk: null,
        };
        return [{ affectedRows: 1, insertId: 60 } as ResultSetHeader, []];
      }
      if (normalized.includes('FROM board_idempotency_records')) {
        return [[stored], []];
      }
      if (normalized.includes('FROM boards b') && normalized.includes('JOIN board_revisions r')) {
        return [
          [
            {
              boardId: 'AAECAwQFBgcICQoLDA0ODw',
              revisionId: Buffer.from('00112233445546778899aabbccddeeff', 'hex'),
            },
          ],
          [],
        ];
      }
      if (normalized.startsWith('INSERT INTO boards')) {
        insertedBoardIds.push(String(binds[0]));
        if (boardCollisionPending) {
          boardCollisionPending = false;
          throw Object.assign(new Error("Duplicate entry for key 'uq_boards_public_id'"), {
            errno: 1062,
            code: 'ER_DUP_ENTRY',
            sqlMessage: "Duplicate entry for key 'uq_boards_public_id'",
          });
        }
        return [{ affectedRows: 1, insertId: 50 } as ResultSetHeader, []];
      }
      if (normalized.startsWith('INSERT INTO board_revisions')) {
        return [{ affectedRows: 1, insertId: 70 } as ResultSetHeader, []];
      }
      if (normalized.startsWith('INSERT INTO board_heads')) {
        return [{ affectedRows: 1, insertId: 0 } as ResultSetHeader, []];
      }
      if (normalized.startsWith('INSERT INTO board_event_outbox')) {
        return [{ affectedRows: 1, insertId: 80 } as ResultSetHeader, []];
      }
      if (normalized.startsWith('UPDATE board_idempotency_records')) {
        assert.ok(stored);
        stored = {
          ...stored,
          statusCode: 'C',
          resultPayload: binds[0],
          resultCanonicalBytes: binds[1],
          resultSha256: binds[2],
          resultBoardPk: String(binds[3]),
          resultRevisionPk: String(binds[4]),
        };
        return [{ affectedRows: 1, insertId: 0 } as ResultSetHeader, []];
      }
      throw new Error(`unexpected SQL: ${normalized}`);
    },
  } as unknown as PoolConnection;
  let bindCount = 0;
  const context: AuthorizedBoardContextV1 = options.mcp
    ? {
        actor: mcpPrincipal().actor,
        ownerUserPk: 20n,
        access: { kind: 'grant', grantPk: 30n, grantId: 'grant_1' as GrantId },
        createBinding: {
          grantPk: 30n,
          grantId: 'grant_1' as GrantId,
          async bindCreatedBoard(_boardId: BoardId) {
            bindCount += 1;
            calls.push('BIND_CREATED_BOARD');
          },
        },
        artifactCapabilityPolicy: {
          allowedArtifactRequestCapabilities: [],
          policyEpoch: 'AAAAAAAAAAAAAAAAAAAAAA',
        },
      }
    : {
        actor: userPrincipal().actor,
        ownerUserPk: 20n,
        access: { kind: 'owner', ownerUserPk: 20n },
        createBinding: null,
        artifactCapabilityPolicy: {
          allowedArtifactRequestCapabilities: [],
          policyEpoch: 'AAAAAAAAAAAAAAAAAAAAAA',
        },
      };
  const policy: BoardAccessPolicy = {
    async withAuthorizedBoardTransaction<T>(
      input: AuthorizedBoardTransactionInputV1,
      apply: (value: PoolConnection, authorized: AuthorizedBoardContextV1) => Promise<T>,
    ) {
      assert.equal(input.operation, 'board.create');
      assert.equal(input.boardId, null);
      assert.equal(input.isolation, 'READ_COMMITTED_WRITE');
      const storedBeforeAttempt = stored;
      try {
        return await apply(connection, context);
      } catch (error) {
        stored = storedBeforeAttempt;
        throw error;
      }
    },
  };
  const generatedIds = [
    '00112233-4455-4677-8899-aabbccddeeff',
    '11112233-4455-4677-8899-aabbccddeeff',
    '22222233-4455-4677-8899-aabbccddeeff',
    '33332233-4455-4677-8899-aabbccddeeff',
    '44442233-4455-4677-8899-aabbccddeeff',
    '55552233-4455-4677-8899-aabbccddeeff',
  ];
  const boardIds = ['AAECAwQFBgcICQoLDA0ODw', 'AQECAwQFBgcICQoLDA0ODw'];
  const crypto = {
    generatePublicIdV1: () => boardIds.shift() ?? 'AgECAwQFBgcICQoLDA0ODw',
  } as CryptoService;
  const service = new BoardCreateService(policy, crypto, new DocumentCheckpointCodec(), {
    now: () => new Date('2026-07-16T12:00:00.000Z'),
    generateUuid: () =>
      generatedIds.shift() ??
      (() => {
        throw new Error('unexpected UUID request');
      })(),
  });
  return { service, connection, context, calls, insertedBoardIds, bindCount: () => bindCount };
};

test('creates an initial empty head and canonical result with zero user binding calls', async () => {
  const value = setup();
  const result = await value.service.create({
    principal: userPrincipal(),
    request: parseCreate('request_1'),
  });
  assert.equal(BoardOperationResultParserV1.parse(result).ok, true);
  assert.equal(result.replayed, false);
  assert.equal(result.result.type, 'board.create');
  if (result.result.type !== 'board.create') return;
  assert.equal(result.result.board.boardId, 'AAECAwQFBgcICQoLDA0ODw');
  assert.equal(result.result.board.headRevision.revisionNumber, 1);
  assert.equal(result.result.snapshot.scene.root, null);
  assert.equal(result.result.snapshot.lastEventSequence, 1);
  assert.equal(value.bindCount(), 0);
  assert.equal(value.calls.includes('BIND_CREATED_BOARD'), false);
});

test('creates a canonical board inside an already-authorized pairing transaction', async () => {
  const value = setup();
  const result = await value.service.createInTransaction({
    connection: value.connection,
    context: value.context,
    request: parseCreate('pairing_request_1', '새 보드'),
  });
  assert.equal(result.result.type, 'board.create');
  if (result.result.type !== 'board.create') return;
  assert.equal(result.result.board.title, '새 보드');
  assert.equal(result.result.snapshot.scene.root, null);
  assert.equal(value.insertedBoardIds.length, 1);
});

test('binds a newly inserted MCP board exactly once before revision 1', async () => {
  const value = setup({ mcp: true });
  await value.service.create({ principal: mcpPrincipal(), request: parseCreate('request_2') });
  assert.equal(value.bindCount(), 1);
  const boardInsert = value.calls.findIndex((call) => call.startsWith('INSERT INTO boards'));
  const binding = value.calls.indexOf('BIND_CREATED_BOARD');
  const revisionInsert = value.calls.findIndex((call) =>
    call.startsWith('INSERT INTO board_revisions'),
  );
  assert.ok(boardInsert >= 0 && boardInsert < binding && binding < revisionInsert);
  assert.equal(value.calls.at(-1)?.startsWith('UPDATE board_idempotency_records'), true);
});

test('replays one validated stored create with a fresh request ID and no domain write', async () => {
  const value = setup();
  const first = await value.service.create({
    principal: userPrincipal(),
    request: parseCreate('request_1'),
  });
  const replay = await value.service.create({
    principal: userPrincipal(),
    request: parseCreate('request_2'),
  });
  assert.equal(replay.requestId, 'request_2');
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.result, first.result);
  assert.equal(value.calls.filter((call) => call.startsWith('INSERT INTO boards')).length, 1);
  assert.equal(
    value.calls.filter((call) => call.startsWith('INSERT INTO board_revisions')).length,
    1,
  );
  assert.equal(
    value.calls.filter((call) => call.startsWith('INSERT INTO board_event_outbox')).length,
    1,
  );
});

test('classifies a changed create title without touching board state', async () => {
  const value = setup();
  await value.service.create({ principal: userPrincipal(), request: parseCreate('request_1') });
  await assert.rejects(
    value.service.create({
      principal: userPrincipal(),
      request: parseCreate('request_2', 'Different title'),
    }),
    (error: unknown) =>
      error instanceof BoardContractError &&
      error.boardError.code === 'IDEMPOTENCY_KEY_REUSED' &&
      error.boardError.details?.reason === 'title_changed',
  );
  assert.equal(value.calls.filter((call) => call.startsWith('INSERT INTO boards')).length, 1);
});

test('rolls back a board public-ID collision and regenerates only that ID', async () => {
  const value = setup({ boardCollisionOnce: true });
  const result = await value.service.create({
    principal: userPrincipal(),
    request: parseCreate('request_1'),
  });
  assert.equal(result.result.type, 'board.create');
  if (result.result.type !== 'board.create') return;
  assert.equal(result.result.board.boardId, 'AQECAwQFBgcICQoLDA0ODw');
  assert.deepEqual(value.insertedBoardIds, ['AAECAwQFBgcICQoLDA0ODw', 'AQECAwQFBgcICQoLDA0ODw']);
  assert.equal(
    value.calls.filter((call) => call.startsWith('INSERT INTO board_revisions')).length,
    1,
  );
});
