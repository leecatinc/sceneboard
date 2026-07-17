import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  BoardOperationRequestParserV1,
  BoardOperationResultParserV1,
  normalizeActorContextV1,
  type ActorContextV1,
  type BoardId,
  type RequestId,
} from '@leecat-board/board-schema';
import type { PoolConnection } from 'mysql2/promise';

import { BoardGetService } from '../../src/boards/board-get.service.js';
import { BoardPersistenceError } from '../../src/common/errors/board-persistence.error.js';
import type {
  AuthorizedBoardContextV1,
  AuthorizedBoardTransactionInputV1,
  BoardAccessPolicy,
  ResolvedBoardPrincipalV1,
} from '../../src/grants/board-access.policy.js';
import { MysqlCurrentBoardCapabilitiesPort } from '../../src/grants/current-board-capabilities.port.js';
import { SceneCheckpointCodec } from '../../src/revisions/scene-checkpoint.codec.js';
import { SnapshotCompositionService } from '../../src/revisions/snapshot-composition.service.js';
import { InactiveCurrentArtifactRuntimeSummaryProvider } from '../../src/snapshots/providers/inactive-current-artifact-runtime-summary.provider.js';
import { InactiveCurrentHitlSummaryProvider } from '../../src/snapshots/providers/inactive-current-hitl-summary.provider.js';

const boardId = 'AAECAwQFBgcICQoLDA0ODw' as BoardId;

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

const request = (): { requestId: RequestId; boardId: BoardId } => {
  const parsed = BoardOperationRequestParserV1.parse({
    protocolVersion: 1,
    requestId: 'request_get_1',
    type: 'board.get',
    boardId,
  });
  assert.equal(parsed.ok, true);
  if (!parsed.ok || parsed.data.value.type !== 'board.get') throw new Error('invalid request fixture');
  return {
    requestId: parsed.data.value.requestId,
    boardId: parsed.data.value.boardId,
  };
};

const setup = async (referenceMismatch = false) => {
  const checkpoint = await new SceneCheckpointCodec().encode({ protocolVersion: 1, type: 'scene', root: null });
  const calls: string[] = [];
  const connection = {
    async execute(sql: string): Promise<[unknown, unknown]> {
      const normalized = sql.replace(/\s+/g, ' ').trim();
      calls.push(normalized);
      if (normalized.includes('FROM boards b') && normalized.includes('JOIN board_heads h')) {
        return [[{
          boardPk: '50',
          boardId,
          title: 'First scene',
          boardCreatedAt: '2026-07-16 12:00:00.000',
          boardUpdatedAt: '2026-07-16 12:00:01.000',
          archivedAt: null,
          revisionPk: '70',
          revisionId: Buffer.from('00112233445546778899aabbccddeeff', 'hex'),
          revisionNumber: '1',
          previousRevisionId: null,
          sourceRevisionId: null,
          originCode: 'C',
          sceneSchemaVersion: checkpoint.schemaVersion,
          sceneCodec: checkpoint.codec,
          scenePayload: checkpoint.payload,
          sceneCanonicalBytes: checkpoint.canonicalBytes,
          sceneStoredBytes: checkpoint.storedBytes,
          sceneSha256: checkpoint.sha256,
          actorKind: 'U',
          actorPrincipalId: 'user_1',
          revisionCreatedAt: '2026-07-16 12:00:01.000',
          lastEventSequence: '1',
        }], []];
      }
      if (normalized.includes('FROM board_revision_artifact_refs')) {
        return [referenceMismatch ? [{
          artifactId: 'artifact_1',
          artifactVersionId: 'version_1',
          referenceCode: 'A',
          occurrenceCount: 1,
        }] : [], []];
      }
      if (normalized.includes('FROM boards b') && normalized.includes('board_artifact_capability_policy_epochs')) {
        return [[{ policyEpoch: Buffer.alloc(16, 7), capability: null }], []];
      }
      throw new Error(`unexpected SQL: ${normalized}`);
    },
  } as unknown as PoolConnection;
  const context: AuthorizedBoardContextV1 = {
    actor: actor(),
    ownerUserPk: 20n,
    access: { kind: 'owner', ownerUserPk: 20n },
    createBinding: null,
    artifactCapabilityPolicy: {
      allowedArtifactRequestCapabilities: [],
      policyEpoch: Buffer.alloc(16, 7).toString('base64url'),
    },
  };
  const policy: BoardAccessPolicy = {
    async withAuthorizedBoardTransaction<T>(
      input: AuthorizedBoardTransactionInputV1,
      apply: (value: PoolConnection, authorized: AuthorizedBoardContextV1) => Promise<T>,
    ) {
      assert.deepEqual(input, {
        principal: input.principal,
        operation: 'board.get',
        boardId,
        isolation: 'REPEATABLE_READ_CUT',
      });
      return apply(connection, context);
    },
  };
  const snapshots = new SnapshotCompositionService(
    new InactiveCurrentHitlSummaryProvider(),
    new InactiveCurrentArtifactRuntimeSummaryProvider(),
    new MysqlCurrentBoardCapabilitiesPort(),
  );
  return {
    calls,
    service: new BoardGetService(policy, new SceneCheckpointCodec(), snapshots),
  };
};

test('returns one D1-valid board snapshot from a single authorized repeatable-read cut', async () => {
  const value = await setup();
  const result = await value.service.get({ principal: principal(), ...request() });
  assert.equal(BoardOperationResultParserV1.parse(result).ok, true);
  assert.equal(result.result.type, 'board.get');
  if (result.result.type !== 'board.get') return;
  assert.equal(result.result.board.boardId, boardId);
  assert.equal(result.result.board.headRevision.revisionNumber, 1);
  assert.equal(result.result.snapshot.scene.root, null);
  assert.equal(result.result.snapshot.lastEventSequence, 1);
  assert.deepEqual(result.result.snapshot.capabilities.grantedCapabilities, [
    'board.history.read',
    'board.read',
    'board.write',
  ]);
  assert.equal(value.calls.length, 3);
  assert.match(value.calls[0] ?? '', /JOIN board_heads h/);
  assert.match(value.calls[1] ?? '', /board_revision_artifact_refs/);
  assert.match(value.calls[2] ?? '', /board_artifact_capability_policy_epochs/);
});

test('fails closed when persisted artifact references do not match the checkpoint', async () => {
  const value = await setup(true);
  await assert.rejects(
    value.service.get({ principal: principal(), ...request() }),
    (error: unknown) => error instanceof BoardPersistenceError && error.category === 'row_integrity',
  );
  assert.equal(value.calls.length, 2);
});
