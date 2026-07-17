import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  MutationRequestParserV1,
  MutationResultParserV1,
  normalizeActorContextV1,
  type ActorContextV1,
  type BoardId,
  type MutationRequestV1,
} from '@leecat-board/board-schema';
import type { PoolConnection, ResultSetHeader } from 'mysql2/promise';

import { BoardContractError } from '../../src/common/errors/app-error.js';
import type {
  AuthorizedBoardContextV1,
  AuthorizedBoardTransactionInputV1,
  BoardAccessPolicy,
  ResolvedBoardPrincipalV1,
} from '../../src/grants/board-access.policy.js';
import { BoardMutationService } from '../../src/revisions/board-mutation.service.js';
import { SceneCheckpointCodec } from '../../src/revisions/scene-checkpoint.codec.js';

const boardId = 'AAECAwQFBgcICQoLDA0ODw' as BoardId;
const headRevisionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const sourceRevisionId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const newRevisionId = '00112233-4455-4677-8899-aabbccddeeff';
const eventId = '11112233-4455-4677-8899-aabbccddeeff';

const actor = (): ActorContextV1 => {
  const parsed = normalizeActorContextV1({
    principalKind: 'user',
    principalId: 'user_1',
    grantId: null,
    scopes: ['board.history.read', 'board.read', 'board.write'],
  });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) throw new Error('invalid actor fixture');
  return parsed.data.value;
};

const principal = (): Extract<ResolvedBoardPrincipalV1, { kind: 'user' }> => ({
  kind: 'user',
  actor: actor(),
  userPk: 20n,
  sessionPk: 21n,
  familyPublicId: 'family_1',
});

const request = (
  type: 'scene.clear' | 'scene.restore',
  requestId: string,
  expectedRevisionId = headRevisionId,
): MutationRequestV1 => {
  const parsed = MutationRequestParserV1.parse({
    protocolVersion: 1,
    requestId,
    idempotencyKey: 'mutation-key-0001',
    boardId,
    expectedRevisionId,
    command: type === 'scene.clear'
      ? { type }
      : { type, sourceRevisionId },
  });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) throw new Error('invalid request fixture');
  return parsed.data.value;
};

const setup = async (type: 'scene.clear' | 'scene.restore') => {
  const calls: string[] = [];
  const sourceCheckpoint = await new SceneCheckpointCodec().encode({
    protocolVersion: 1,
    type: 'scene',
    root: null,
  });
  let stored: Record<string, unknown> | null = null;
  let revisionWrites = 0;
  let sourceReads = 0;
  let referenceReads = 0;
  const connection = {
    async execute(sql: string, binds: unknown[] = []): Promise<[unknown, unknown]> {
      const normalized = sql.replace(/\s+/g, ' ').trim();
      calls.push(normalized);
      if (normalized.startsWith('INSERT INTO board_idempotency_records')) {
        if (stored !== null) return [{ affectedRows: 0, insertId: 60 } as ResultSetHeader, []];
        stored = {
          statusCode: 'P',
          operationType: binds[5],
          fingerprintSha256: binds[8],
          actorGrantId: binds[9],
          actorScopesSha256: binds[11],
          expectedRevisionId: binds[12],
          commandPayloadSha256: binds[13],
          resultPayload: null,
          resultCanonicalBytes: null,
          resultSha256: null,
          resultBoardPk: null,
          resultRevisionPk: null,
        };
        return [{ affectedRows: 1, insertId: 60 } as ResultSetHeader, []];
      }
      if (normalized.includes('FROM board_idempotency_records')) return [[stored], []];
      if (normalized.includes('FROM boards b') && normalized.includes('JOIN board_revisions r')
        && normalized.includes('r.revision_id = ?')) {
        sourceReads += 1;
        return [[{
          revisionPk: '65',
          revisionId: Buffer.from(sourceRevisionId.replaceAll('-', ''), 'hex'),
          revisionNumber: '1',
          sceneSchemaVersion: sourceCheckpoint.schemaVersion,
          sceneCodec: sourceCheckpoint.codec,
          scenePayload: sourceCheckpoint.payload,
          sceneCanonicalBytes: sourceCheckpoint.canonicalBytes,
          sceneStoredBytes: sourceCheckpoint.storedBytes,
          sceneSha256: sourceCheckpoint.sha256,
        }], []];
      }
      if (normalized.includes('FROM board_revision_artifact_refs')) {
        referenceReads += 1;
        return [[], []];
      }
      if (normalized.includes('FROM boards b') && normalized.includes('JOIN board_heads h')
        && normalized.endsWith('FOR UPDATE')) {
        return [[{
          boardPk: '50',
          archivedAt: null,
          headRevisionPk: '70',
          headRevisionId: Buffer.from(headRevisionId.replaceAll('-', ''), 'hex'),
          headRevisionNumber: '2',
          lastEventSequence: '2',
        }], []];
      }
      if (normalized.includes('FROM board_revisions') && normalized.includes('revision_pk = ?')) {
        sourceReads += 1;
        return [[{
          revisionPk: '65',
          revisionId: Buffer.from(sourceRevisionId.replaceAll('-', ''), 'hex'),
          revisionNumber: '1',
          sceneSchemaVersion: sourceCheckpoint.schemaVersion,
          sceneCodec: sourceCheckpoint.codec,
          scenePayload: sourceCheckpoint.payload,
          sceneCanonicalBytes: sourceCheckpoint.canonicalBytes,
          sceneStoredBytes: sourceCheckpoint.storedBytes,
          sceneSha256: sourceCheckpoint.sha256,
        }], []];
      }
      if (normalized.startsWith('INSERT INTO board_revisions')) {
        revisionWrites += 1;
        return [{ affectedRows: 1, insertId: 71 } as ResultSetHeader, []];
      }
      if (normalized.startsWith('UPDATE board_heads')) {
        return [{ affectedRows: 1, insertId: 0 } as ResultSetHeader, []];
      }
      if (normalized.startsWith('UPDATE boards SET')) {
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
      if (normalized.includes('FROM boards b') && normalized.includes('JOIN board_event_outbox e')) {
        return [[{
          boardId,
          revisionId: Buffer.from(newRevisionId.replaceAll('-', ''), 'hex'),
          eventId: Buffer.from(eventId.replaceAll('-', ''), 'hex'),
        }], []];
      }
      throw new Error(`unexpected SQL: ${normalized}`);
    },
  } as unknown as PoolConnection;
  const context: AuthorizedBoardContextV1 = {
    actor: actor(),
    ownerUserPk: 20n,
    access: { kind: 'owner', ownerUserPk: 20n },
    createBinding: null,
    artifactCapabilityPolicy: { allowedArtifactRequestCapabilities: [], policyEpoch: 'AAAAAAAAAAAAAAAAAAAAAA' },
  };
  const policy: BoardAccessPolicy = {
    async withAuthorizedBoardTransaction<T>(
      input: AuthorizedBoardTransactionInputV1,
      apply: (value: PoolConnection, authorized: AuthorizedBoardContextV1) => Promise<T>,
    ) {
      assert.equal(input.operation, type);
      assert.equal(input.boardId, boardId);
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
  const generated = [
    newRevisionId,
    eventId,
    '22222233-4455-4677-8899-aabbccddeeff',
  ];
  return {
    calls,
    revisionWrites: () => revisionWrites,
    sourceReads: () => sourceReads,
    referenceReads: () => referenceReads,
    service: new BoardMutationService(policy, new SceneCheckpointCodec(), {
      now: () => new Date('2026-07-16T12:00:00.000Z'),
      generateUuid: () => generated.shift() ?? '33332233-4455-4677-8899-aabbccddeeff',
    }),
  };
};

test('scene.clear atomically appends one immutable checkpoint, CAS head, event, and result', async () => {
  const value = await setup('scene.clear');
  const result = await value.service.applySceneMutation({
    principal: principal(),
    request: request('scene.clear', 'request_mutation_1'),
  });
  assert.equal(MutationResultParserV1.parse(result).ok, true);
  assert.equal(result.result.type, 'scene.clear');
  if (result.result.type !== 'scene.clear') return;
  assert.equal(result.result.revision.revisionNumber, 3);
  assert.deepEqual(result.eventIds, [eventId]);
  assert.equal(value.revisionWrites(), 1);
  const revisionIndex = value.calls.findIndex((call) => call.startsWith('INSERT INTO board_revisions'));
  const headIndex = value.calls.findIndex((call) => call.startsWith('UPDATE board_heads'));
  const eventIndex = value.calls.findIndex((call) => call.startsWith('INSERT INTO board_event_outbox'));
  const completeIndex = value.calls.findIndex((call) => call.startsWith('UPDATE board_idempotency_records'));
  assert.ok(revisionIndex < headIndex && headIndex < eventIndex && eventIndex < completeIndex);
});

test('identical clear retry replays stored result while changed expected head is classified first', async () => {
  const value = await setup('scene.clear');
  const first = await value.service.applySceneMutation({
    principal: principal(),
    request: request('scene.clear', 'request_mutation_1'),
  });
  const replay = await value.service.applySceneMutation({
    principal: principal(),
    request: request('scene.clear', 'request_mutation_2'),
  });
  assert.equal(replay.replayed, true);
  assert.equal(replay.requestId, 'request_mutation_2');
  assert.deepEqual(replay.result, first.result);
  assert.equal(value.revisionWrites(), 1);
  await assert.rejects(
    value.service.applySceneMutation({
      principal: principal(),
      request: request('scene.clear', 'request_mutation_3', sourceRevisionId),
    }),
    (error: unknown) => error instanceof BoardContractError
      && error.boardError.code === 'IDEMPOTENCY_KEY_REUSED'
      && error.boardError.details?.reason === 'expected_revision_changed',
  );
  assert.equal(value.revisionWrites(), 1);
});

test('restore copies one verified immutable source and replay never reads or decompresses it again', async () => {
  const value = await setup('scene.restore');
  const first = await value.service.applySceneMutation({
    principal: principal(),
    request: request('scene.restore', 'request_restore_1'),
  });
  assert.equal(first.result.type, 'scene.restore');
  assert.equal(value.sourceReads(), 2);
  assert.equal(value.referenceReads(), 2);
  const replay = await value.service.applySceneMutation({
    principal: principal(),
    request: request('scene.restore', 'request_restore_2'),
  });
  assert.equal(replay.replayed, true);
  assert.equal(value.sourceReads(), 2);
  assert.equal(value.referenceReads(), 2);
  assert.equal(value.revisionWrites(), 1);
});
