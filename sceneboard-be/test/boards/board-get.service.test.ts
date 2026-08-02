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
  type RequestId,
} from '@sceneboard/board-schema';
import type { PoolConnection } from 'mysql2/promise';

import { BoardGetService } from '../../src/boards/board-get.service.js';
import { BoardPersistenceError } from '../../src/common/errors/board-persistence.error.js';
import { BoardContractError } from '../../src/common/errors/app-error.js';
import type {
  AuthorizedBoardContextV1,
  AuthorizedBoardTransactionInputV1,
  BoardAccessPolicy,
  ResolvedBoardPrincipalV1,
} from '../../src/grants/board-access.policy.js';
import { MysqlCurrentBoardCapabilitiesPort } from '../../src/grants/current-board-capabilities.port.js';
import { DocumentCheckpointCodec } from '../../src/revisions/document-checkpoint.codec.js';
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
  isBrowserCredential: true,
});

const request = (): { requestId: RequestId; boardId: BoardId } => {
  const parsed = BoardOperationRequestParserV1.parse({
    protocolVersion: 1,
    requestId: 'request_get_1',
    type: 'board.get',
    boardId,
  });
  assert.equal(parsed.ok, true);
  if (!parsed.ok || parsed.data.value.type !== 'board.get')
    throw new Error('invalid request fixture');
  return {
    requestId: parsed.data.value.requestId,
    boardId: parsed.data.value.boardId,
  };
};

const setup = async (
  referenceMismatch = false,
  documentMode: boolean | 3 = false,
  checkpointOverrides: Record<string, unknown> = {},
  inlineCheckpointCleared = false,
) => {
  const checkpoint = documentMode
    ? documentMode === 3
      ? await new DocumentCheckpointCodec().encodeDocumentV3({
          schemaVersion: 3,
          format: 'a4_portrait',
          defaultPageId: 'page_1',
          pages: [
            {
              pageId: 'page_1',
              title: '',
              displayMode: 'fit-page',
              scene: { protocolVersion: 1, type: 'scene', root: null },
            },
          ],
        })
      : await new DocumentCheckpointCodec().encodeDocument({
          schemaVersion: 2,
          defaultPageId: 'page_1',
          pages: [
            {
              pageId: 'page_1',
              title: '',
              displayMode: 'fit-page',
              scene: { protocolVersion: 1, type: 'scene', root: null },
            },
          ],
        })
    : await new DocumentCheckpointCodec().encodeScene({
        protocolVersion: 1,
        type: 'scene',
        root: null,
      });
  const calls: string[] = [];
  const connection = {
    async execute(sql: string): Promise<[unknown, unknown]> {
      const normalized = sql.replace(/\s+/g, ' ').trim();
      calls.push(normalized);
      if (normalized.includes('FROM boards b') && normalized.includes('JOIN board_heads h')) {
        const detachedSelected = normalized.includes(
          "LEFT JOIN board_revision_payloads p ON p.revision_pk = r.revision_pk AND p.state = 'available'",
        );
        const effectiveCheckpoint =
          !inlineCheckpointCleared || detachedSelected ? checkpoint : null;
        return [
          [
            {
              boardPk: '50',
              boardId,
              title: 'First scene',
              boardCreatedAt: '2026-07-16 12:00:00.000',
              boardUpdatedAt: '2026-07-16 12:00:01.000',
              archivedAt: null,
              revisionPk: '70',
              revisionId: Buffer.from('00112233445546778899aabbccddeeff', 'hex'),
              revisionNumber: documentMode ? '2' : '1',
              previousRevisionId: documentMode
                ? Buffer.from('10112233445546778899aabbccddeeff', 'hex')
                : null,
              sourceRevisionId: null,
              originCode: documentMode ? 'D' : 'C',
              sceneSchemaVersion: effectiveCheckpoint?.schemaVersion ?? null,
              sceneCodec: effectiveCheckpoint?.codec ?? null,
              scenePayload: effectiveCheckpoint?.payload ?? null,
              sceneCanonicalBytes: effectiveCheckpoint?.canonicalBytes ?? null,
              sceneStoredBytes: effectiveCheckpoint?.storedBytes ?? null,
              sceneSha256: effectiveCheckpoint?.sha256 ?? null,
              ...checkpointOverrides,
              actorKind: 'U',
              actorPrincipalId: 'user_1',
              revisionCreatedAt: '2026-07-16 12:00:01.000',
              lastEventSequence: documentMode ? '2' : '1',
            },
          ],
          [],
        ];
      }
      if (normalized.includes('FROM board_revision_artifact_refs')) {
        return [
          referenceMismatch
            ? [
                {
                  artifactId: 'artifact_1',
                  artifactVersionId: 'version_1',
                  referenceCode: 'A',
                  occurrenceCount: 1,
                },
              ]
            : [],
          [],
        ];
      }
      if (
        normalized.includes('FROM boards b') &&
        normalized.includes('board_artifact_capability_policy_epochs')
      ) {
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
    service: new BoardGetService(policy, new DocumentCheckpointCodec(), snapshots),
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
    (error: unknown) =>
      error instanceof BoardPersistenceError && error.category === 'row_integrity',
  );
  assert.equal(value.calls.length, 2);
});

test('decodes a v2 document head and returns matching v2 capabilities without a Scene cast', async () => {
  const value = await setup(false, true);
  const result = await value.service.get({ principal: principal(), ...request() });
  assert.equal(result.result.type, 'board.get');
  if (result.result.type !== 'board.get') return;
  assert.equal('document' in result.result.snapshot, true);
  if (!('document' in result.result.snapshot)) return;
  assert.equal(result.result.snapshot.document.defaultPageId, 'page_1');
  assert.equal(result.result.snapshot.revision.originType, 'document.replace');
  assert.equal(result.result.snapshot.capabilities.schemaVersion, '1.1.0');
  assert.equal(result.result.snapshot.lastEventSequence, 2);
});

test('V3 head requires an explicit capable selector and projects deterministically for V2 readers', async () => {
  const omitted = await setup(false, 3);
  await assert.rejects(
    omitted.service.get({ principal: principal(), ...request() }),
    (error: unknown) =>
      error instanceof BoardContractError &&
      error.boardError.code === 'UPGRADE_REQUIRED' &&
      error.boardError.details.headSchemaVersion === 3,
  );

  const v2 = await setup(false, 3);
  const projected = await v2.service.get({
    principal: principal(),
    ...request(),
    documentSchemaVersion: 2,
  });
  assert.equal(BoardOperationResultParserV2.parse(projected).ok, true);
  if (projected.result.type !== 'board.get' || !('document' in projected.result.snapshot)) return;
  assert.equal(projected.result.snapshot.document.schemaVersion, 2);

  const v3 = await setup(false, 3);
  const native = await v3.service.get({
    principal: principal(),
    ...request(),
    documentSchemaVersion: 3,
  });
  assert.equal(BoardOperationResultParserV3.parse(native).ok, true);
  if (native.result.type !== 'board.get' || !('document' in native.result.snapshot)) return;
  assert.equal(native.result.snapshot.document.schemaVersion, 3);
  if (native.result.snapshot.document.schemaVersion === 3)
    assert.equal(native.result.snapshot.document.format, 'a4_portrait');
});

test('reads every effective current-head checkpoint field from one available detached row before inline fallback', async () => {
  const value = await setup(false, 3);
  const result = await value.service.get({
    principal: principal(),
    ...request(),
    documentSchemaVersion: 3,
  });
  assert.equal(BoardOperationResultParserV3.parse(result).ok, true);
  const sql = value.calls[0] ?? '';
  assert.match(
    sql,
    /LEFT JOIN board_revision_payloads p ON p\.revision_pk = r\.revision_pk AND p\.state = 'available'/u,
  );
  for (const [detached, inline] of [
    ['p.schema_version', 'r.scene_schema_version'],
    ['p.codec', 'r.scene_codec'],
    ['p.payload', 'r.scene_payload'],
    ['p.canonical_bytes', 'r.scene_canonical_bytes'],
    ['p.stored_bytes', 'r.scene_stored_bytes'],
    ['p.payload_sha256', 'r.scene_sha256'],
  ] as const) {
    assert.match(
      sql,
      new RegExp(
        `CASE WHEN p\\.revision_pk IS NOT NULL THEN ${detached.replace('.', '\\.')} ELSE ${inline.replace('.', '\\.')} END`,
        'u',
      ),
    );
  }
});

test('decodes the available detached current head after all six inline fields are cleared', async () => {
  const value = await setup(false, 3, {}, true);
  const result = await value.service.get({
    principal: principal(),
    ...request(),
    documentSchemaVersion: 3,
  });
  assert.equal(BoardOperationResultParserV3.parse(result).ok, true);
  assert.equal(result.result.type, 'board.get');
  if (result.result.type !== 'board.get' || !('document' in result.result.snapshot)) return;
  assert.equal(result.result.snapshot.document.schemaVersion, 3);
  assert.match(
    value.calls[0] ?? '',
    /LEFT JOIN board_revision_payloads p ON p\.revision_pk = r\.revision_pk AND p\.state = 'available'/u,
  );
});

test('fails closed when neither detached nor inline current-head checkpoint is complete or intact', async () => {
  const partial = await setup(false, false, { scenePayload: null });
  await assert.rejects(
    partial.service.get({ principal: principal(), ...request() }),
    (error: unknown) =>
      error instanceof BoardPersistenceError && error.category === 'row_integrity',
  );

  const corrupt = await setup(false, false, { sceneSha256: Buffer.alloc(32, 9) });
  await assert.rejects(
    corrupt.service.get({ principal: principal(), ...request() }),
    (error: unknown) =>
      error instanceof BoardPersistenceError && error.category === 'checkpoint_integrity',
  );
});
