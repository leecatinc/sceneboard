import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  BoardOperationRequestParserV1,
  BoardOperationResultParserV1,
  normalizeActorContextV1,
  type ActorContextV1,
  type BoardId,
} from '@sceneboard/board-schema';
import type { PoolConnection } from 'mysql2/promise';

import { createCursorMacKeyV1 } from '../../src/common/security/cursor-mac-key.js';
import type {
  AuthorizedBoardContextV1,
  AuthorizedBoardTransactionInputV1,
  BoardAccessPolicy,
  ResolvedBoardPrincipalV1,
} from '../../src/grants/board-access.policy.js';
import { MysqlCurrentBoardCapabilitiesPort } from '../../src/grants/current-board-capabilities.port.js';
import { HistoryCursorCodec } from '../../src/history/history-cursor.codec.js';
import {
  HistoryGetService,
  type HistoryGetRequestV1,
} from '../../src/history/history-get.service.js';
import {
  HistoryListService,
  type HistoryListRequestV1,
} from '../../src/history/history-list.service.js';
import { SceneCheckpointCodec } from '../../src/revisions/scene-checkpoint.codec.js';
import { SnapshotCompositionService } from '../../src/revisions/snapshot-composition.service.js';
import { InactiveCurrentArtifactRuntimeSummaryProvider } from '../../src/snapshots/providers/inactive-current-artifact-runtime-summary.provider.js';
import { InactiveCurrentHitlSummaryProvider } from '../../src/snapshots/providers/inactive-current-hitl-summary.provider.js';

const boardId = 'AAECAwQFBgcICQoLDA0ODw' as BoardId;
const revisions = [
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
] as const;
const bytes = (value: string): Buffer => Buffer.from(value.replaceAll('-', ''), 'hex');

const actor = (): ActorContextV1 => {
  const parsed = normalizeActorContextV1({
    principalKind: 'user',
    principalId: 'user_1',
    grantId: null,
    scopes: ['board.history.read', 'board.read'],
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

const context = (): AuthorizedBoardContextV1 => ({
  actor: actor(),
  ownerUserPk: 20n,
  access: { kind: 'owner', ownerUserPk: 20n },
  createBinding: null,
  artifactCapabilityPolicy: {
    allowedArtifactRequestCapabilities: [],
    policyEpoch: 'AAAAAAAAAAAAAAAAAAAAAA',
  },
});

const parseList = (): HistoryListRequestV1 => {
  const parsed = BoardOperationRequestParserV1.parse({
    protocolVersion: 1,
    requestId: 'request_history_list_1',
    type: 'history.list',
    boardId,
    cursor: null,
    limit: 2,
  });
  assert.equal(parsed.ok, true);
  if (!parsed.ok || parsed.data.value.type !== 'history.list')
    throw new Error('invalid list fixture');
  return parsed.data.value as HistoryListRequestV1;
};

const parseGet = (): HistoryGetRequestV1 => {
  const parsed = BoardOperationRequestParserV1.parse({
    protocolVersion: 1,
    requestId: 'request_history_get_1',
    type: 'history.get',
    boardId,
    revisionId: revisions[0],
  });
  assert.equal(parsed.ok, true);
  if (!parsed.ok || parsed.data.value.type !== 'history.get')
    throw new Error('invalid get fixture');
  return parsed.data.value as HistoryGetRequestV1;
};

test('history list uses one narrow newest-first page and cursors from the last returned revision', async () => {
  const calls: Array<{ sql: string; binds: unknown[] }> = [];
  const connection = {
    async execute(sql: string, binds: unknown[]): Promise<[unknown, unknown]> {
      const normalized = sql.replace(/\s+/g, ' ').trim();
      calls.push({ sql: normalized, binds });
      return [
        [
          {
            revisionId: bytes(revisions[2]),
            revisionNumber: '3',
            revisionCreatedAt: '2026-07-16 12:00:03.000',
            previousRevisionId: bytes(revisions[1]),
            sourceRevisionId: null,
            originCode: 'L',
            actorKind: 'U',
            actorPrincipalId: 'user_1',
            label: 'Cleared',
          },
          {
            revisionId: bytes(revisions[1]),
            revisionNumber: '2',
            revisionCreatedAt: '2026-07-16 12:00:02.000',
            previousRevisionId: bytes(revisions[0]),
            sourceRevisionId: null,
            originCode: 'R',
            actorKind: 'U',
            actorPrincipalId: 'user_1',
            label: 'Updated',
          },
          {
            revisionId: bytes(revisions[0]),
            revisionNumber: '1',
            revisionCreatedAt: '2026-07-16 12:00:01.000',
            previousRevisionId: null,
            sourceRevisionId: null,
            originCode: 'C',
            actorKind: 'U',
            actorPrincipalId: 'user_1',
            label: 'Created',
          },
        ],
        [],
      ];
    },
  } as unknown as PoolConnection;
  const policy: BoardAccessPolicy = {
    async withAuthorizedBoardTransaction<T>(
      input: AuthorizedBoardTransactionInputV1,
      apply: (value: PoolConnection, authorized: AuthorizedBoardContextV1) => Promise<T>,
    ) {
      assert.equal(input.operation, 'history.list');
      return apply(connection, context());
    },
  };
  const cursors = new HistoryCursorCodec(createCursorMacKeyV1(Buffer.alloc(32, 8)));
  const response = await new HistoryListService(policy, cursors).listWithMetadata({
    principal: principal(),
    request: parseList(),
  });
  const result = response.result;
  assert.equal(BoardOperationResultParserV1.parse(result).ok, true);
  assert.equal(result.result.type, 'history.list');
  if (result.result.type !== 'history.list' || result.result.nextCursor === null) return;
  assert.deepEqual(
    result.result.entries.map(
      (entry: { revision: { revisionNumber: number } }) => entry.revision.revisionNumber,
    ),
    [3, 2],
  );
  assert.equal(cursors.parse(result.result.nextCursor, boardId), 2);
  assert.deepEqual(response.metadata, {
    protocolVersion: 1,
    type: 'history.adapter-metadata',
    entries: [
      { revisionId: revisions[2], label: 'Cleared' },
      { revisionId: revisions[1], label: 'Updated' },
    ],
    navigation: null,
  });
  assert.equal(calls.length, 1);
  assert.doesNotMatch(calls[0]?.sql ?? '', /scene_payload|COUNT\(/i);
  assert.match(calls[0]?.sql ?? '', /LIMIT 3$/);
  assert.deepEqual(calls[0]?.binds, [boardId]);
});

test('history get composes an immutable selected scene with current response-cut capabilities and watermark', async () => {
  const checkpoint = await new SceneCheckpointCodec().encode({
    protocolVersion: 1,
    type: 'scene',
    root: null,
  });
  const calls: string[] = [];
  const connection = {
    async execute(sql: string): Promise<[unknown, unknown]> {
      const normalized = sql.replace(/\s+/g, ' ').trim();
      calls.push(normalized);
      if (normalized.includes('JOIN board_revisions latest')) {
        return [
          [
            {
              revisionPk: '65',
              revisionId: bytes(revisions[0]),
              revisionNumber: '1',
              revisionCreatedAt: '2026-07-16 12:00:01.000',
              previousRevisionId: null,
              sourceRevisionId: null,
              originCode: 'C',
              actorKind: 'U',
              actorPrincipalId: 'user_1',
              label: 'Created',
              nextRevisionId: bytes(revisions[1]),
              latestRevisionId: bytes(revisions[2]),
              sceneSchemaVersion: checkpoint.schemaVersion,
              sceneCodec: checkpoint.codec,
              scenePayload: checkpoint.payload,
              sceneCanonicalBytes: checkpoint.canonicalBytes,
              sceneStoredBytes: checkpoint.storedBytes,
              sceneSha256: checkpoint.sha256,
              lastEventSequence: '3',
            },
          ],
          [],
        ];
      }
      if (normalized.includes('FROM board_revision_artifact_refs')) return [[], []];
      if (normalized.includes('board_artifact_capability_policy_epochs')) {
        return [[{ policyEpoch: Buffer.alloc(16, 6), capability: null }], []];
      }
      throw new Error(`unexpected SQL: ${normalized}`);
    },
  } as unknown as PoolConnection;
  const policy: BoardAccessPolicy = {
    async withAuthorizedBoardTransaction<T>(
      input: AuthorizedBoardTransactionInputV1,
      apply: (value: PoolConnection, authorized: AuthorizedBoardContextV1) => Promise<T>,
    ) {
      assert.equal(input.operation, 'history.get');
      assert.equal(input.isolation, 'REPEATABLE_READ_CUT');
      return apply(connection, context());
    },
  };
  const snapshots = new SnapshotCompositionService(
    new InactiveCurrentHitlSummaryProvider(),
    new InactiveCurrentArtifactRuntimeSummaryProvider(),
    new MysqlCurrentBoardCapabilitiesPort(),
  );
  const response = await new HistoryGetService(
    policy,
    new SceneCheckpointCodec(),
    snapshots,
  ).getWithMetadata({ principal: principal(), request: parseGet() });
  const result = response.result;
  assert.equal(BoardOperationResultParserV1.parse(result).ok, true);
  assert.equal(result.result.type, 'history.get');
  if (result.result.type !== 'history.get') return;
  assert.equal(result.result.entry.revision.revisionNumber, 1);
  assert.equal(result.result.snapshot.scene.root, null);
  assert.equal(result.result.snapshot.lastEventSequence, 3);
  assert.deepEqual(result.result.snapshot.capabilities.grantedCapabilities, [
    'board.history.read',
    'board.read',
  ]);
  assert.deepEqual(response.metadata, {
    protocolVersion: 1,
    type: 'history.adapter-metadata',
    entries: [{ revisionId: revisions[0], label: 'Created' }],
    navigation: {
      revisionId: revisions[0],
      previousRevisionId: null,
      nextRevisionId: revisions[1],
      latestRevisionId: revisions[2],
    },
  });
  assert.equal(calls.length, 3);
});
