import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  BoardOperationRequestParserV1,
  BoardOperationResultParserV1,
  BoardOperationResultParserV2,
  BoardOperationResultParserV3,
  normalizeActorContextV1,
  type ActorContextV1,
  type BoardId,
  type GrantId,
  type RevisionId,
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
import { DocumentCheckpointCodec } from '../../src/revisions/document-checkpoint.codec.js';
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
  isBrowserCredential: true,
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
      if (normalized.includes('SELECT oldest.revision_id AS oldestRetainedRevisionId')) {
        return [
          [
            {
              oldestRetainedRevisionId: bytes(revisions[0]),
              truncatedBefore: 0,
            },
          ],
          [],
        ];
      }
      return [
        [
          {
            revisionId: bytes(revisions[2]),
            revisionNumber: '3',
            revisionCreatedAt: '2026-07-16 12:00:03.000',
            previousRevisionId: bytes(revisions[1]),
            sourceRevisionId: null,
            originCode: 'D',
            actorKind: 'U',
            actorPrincipalId: 'user_1',
            label: 'Cleared',
            retainedOrder: '3',
            truncatedBefore: 0,
            actorAccountPk: '20',
            actorClass: 'owner',
            sceneSchemaVersion: '1.0.0',
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
            retainedOrder: '2',
            truncatedBefore: 0,
            actorAccountPk: '20',
            actorClass: 'owner',
            sceneSchemaVersion: '1.0.0',
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
            retainedOrder: '1',
            truncatedBefore: 0,
            actorAccountPk: '20',
            actorClass: 'owner',
            sceneSchemaVersion: '1.0.0',
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
  assert.equal(result.result.entries[0]?.originType, 'document.replace');
  assert.equal(
    cursors.parse(result.result.nextCursor, {
      boardId,
      limit: 2,
      access: { accessKind: 'owner', ownerUserId: '20' },
      retentionBoundary: revisions[0] as RevisionId,
    }),
    2,
  );
  assert.deepEqual(response.metadata, {
    protocolVersion: 1,
    type: 'history.adapter-metadata',
    entries: [
      { revisionId: revisions[2], label: 'Cleared' },
      { revisionId: revisions[1], label: 'Updated' },
    ],
    navigation: null,
  });
  assert.equal(calls.length, 2);
  assert.match(calls[0]?.sql ?? '', /oldestRetainedRevisionId/);
  assert.doesNotMatch(calls[1]?.sql ?? '', /scene_payload|COUNT\(/i);
  assert.match(calls[1]?.sql ?? '', /LIMIT 3$/);
  assert.deepEqual(calls[1]?.binds, [boardId]);
});

test('history list rejects changed request, access, anchor, and retention contexts before page reads', async () => {
  const key = createCursorMacKeyV1(Buffer.alloc(32, 8));
  const cursors = new HistoryCursorCodec(key);
  const originalContext = {
    boardId,
    limit: 2,
    access: { accessKind: 'owner' as const, ownerUserId: '20' },
    retentionBoundary: revisions[0] as RevisionId,
  };
  const cursor = cursors.issue({ ...originalContext, beforeRevisionNumber: 2 });
  const pageReads: string[] = [];
  let boundary: string = revisions[0];
  let authorized = context();
  const connection = {
    async execute(sql: string): Promise<[unknown, unknown]> {
      const normalized = sql.replace(/\s+/g, ' ').trim();
      if (normalized.includes('SELECT oldest.revision_id AS oldestRetainedRevisionId'))
        return [
          [
            {
              oldestRetainedRevisionId: bytes(boundary),
              truncatedBefore: boundary === revisions[0] ? 0 : 1,
            },
          ],
          [],
        ];
      if (normalized.includes('SELECT c.revision_pk')) return [[], []];
      pageReads.push(normalized);
      return [[], []];
    },
  } as unknown as PoolConnection;
  const policy: BoardAccessPolicy = {
    async withAuthorizedBoardTransaction<T>(
      _input: AuthorizedBoardTransactionInputV1,
      apply: (value: PoolConnection, authorized: AuthorizedBoardContextV1) => Promise<T>,
    ) {
      return apply(connection, authorized);
    },
  };
  const service = new HistoryListService(policy, cursors);
  const expectInvalid = async (request: HistoryListRequestV1): Promise<void> => {
    await assert.rejects(
      service.listWithMetadata({ principal: principal(), request }),
      (error: unknown) =>
        error instanceof Error &&
        'boardError' in error &&
        (error as { boardError: { code: string } }).boardError.code === 'INVALID_PAYLOAD',
    );
  };
  await expectInvalid({ ...parseList(), cursor, limit: 1 });
  await expectInvalid({
    ...parseList(),
    boardId: 'AQECAwQFBgcICQoLDA0ODw' as BoardId,
    cursor,
  });
  for (const access of [
    { kind: 'owner' as const, ownerUserPk: 21n },
    { kind: 'grant' as const, grantPk: 30n, grantId: 'grant_1' as GrantId },
    { kind: 'api_key' as const, ownerUserPk: 20n, apiKeyPk: 70n },
  ]) {
    authorized = { ...context(), access };
    await expectInvalid({ ...parseList(), cursor });
  }
  authorized = context();
  await expectInvalid({ ...parseList(), cursor });
  assert.equal(pageReads.length, 0);

  boundary = revisions[1];
  await expectInvalid({ ...parseList(), cursor });
  assert.equal(pageReads.length, 0);
});

test('history get projects V3 history for V2 readers and preserves format for explicit V3 readers', async () => {
  const checkpoint = await new DocumentCheckpointCodec().encodeDocumentV3({
    schemaVersion: 3,
    format: 'a4_landscape',
    defaultPageId: 'page_1',
    pages: [
      {
        pageId: 'page_1',
        title: '',
        displayMode: 'fit-page',
        scene: { protocolVersion: 1, type: 'scene', root: null },
      },
    ],
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
              revisionNumber: '2',
              revisionCreatedAt: '2026-07-16 12:00:01.000',
              previousRevisionId: bytes(revisions[1]),
              sourceRevisionId: null,
              originCode: 'D',
              actorKind: 'U',
              actorPrincipalId: 'user_1',
              label: 'Updated document',
              nextRevisionId: bytes(revisions[2]),
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
      if (normalized.includes('FROM board_revision_media_refs')) return [[], []];
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
  const service = new HistoryGetService(policy, new DocumentCheckpointCodec(), snapshots);
  const response = await service.getWithMetadata({
    principal: principal(),
    request: { ...parseGet(), documentSchemaVersion: 2 },
  });
  const result = response.result;
  assert.equal(BoardOperationResultParserV2.parse(result).ok, true);
  assert.equal(result.result.type, 'history.get');
  if (result.result.type !== 'history.get') return;
  assert.equal(result.result.entry.revision.revisionNumber, 2);
  assert.equal('document' in result.result.snapshot, true);
  if (!('document' in result.result.snapshot)) return;
  assert.equal(result.result.snapshot.document.schemaVersion, 2);
  assert.equal(result.result.snapshot.document.defaultPageId, 'page_1');
  assert.equal(result.result.snapshot.capabilities.schemaVersion, '1.1.0');
  assert.equal(result.result.snapshot.lastEventSequence, 3);
  assert.deepEqual(result.result.snapshot.capabilities.grantedCapabilities, [
    'board.history.read',
    'board.read',
  ]);
  assert.deepEqual(response.metadata, {
    protocolVersion: 1,
    type: 'history.adapter-metadata',
    entries: [{ revisionId: revisions[0], label: 'Updated document' }],
    navigation: {
      revisionId: revisions[0],
      previousRevisionId: revisions[1],
      nextRevisionId: revisions[2],
      latestRevisionId: revisions[2],
    },
  });
  assert.equal(calls.length, 4);

  const native = await service.getWithMetadata({
    principal: principal(),
    request: { ...parseGet(), documentSchemaVersion: 3 },
  });
  assert.equal(BoardOperationResultParserV3.parse(native.result).ok, true);
  if (native.result.result.type !== 'history.get' || !('document' in native.result.result.snapshot))
    return;
  assert.equal(native.result.result.snapshot.document.schemaVersion, 3);
  if (native.result.result.snapshot.document.schemaVersion === 3)
    assert.equal(native.result.result.snapshot.document.format, 'a4_landscape');
  assert.equal(calls.length, 8);
});
