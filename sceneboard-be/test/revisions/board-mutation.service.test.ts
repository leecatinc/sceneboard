import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  BoardEventEnvelopeParserV2,
  MAX_ARTIFACT_REFERENCE_OCCURRENCES,
  MutationRequestParserV1,
  MutationRequestParserV2,
  MutationRequestParserV3,
  MutationResultParserV1,
  MutationResultParserV2,
  MutationResultParserV3,
  normalizeActorContextV1,
  type ActorContextV1,
  type BoardId,
  type MutationRequestV1,
  type MutationRequestV2,
  type MutationRequestV3,
} from '@sceneboard/board-schema';
import type { PoolConnection, ResultSetHeader } from 'mysql2/promise';

import { BoardContractError } from '../../src/common/errors/app-error.js';
import { BoardPersistenceError } from '../../src/common/errors/board-persistence.error.js';
import {
  ACCOUNT_API_KEY_SNAPSHOT,
  type AuthorizedBoardContextV1,
  type AuthorizedBoardTransactionInputV1,
  type BoardAccessPolicy,
  type ResolvedBoardPrincipalV1,
} from '../../src/grants/board-access.policy.js';
import { BoardMutationService } from '../../src/revisions/board-mutation.service.js';
import { DocumentCheckpointCodec } from '../../src/revisions/document-checkpoint.codec.js';

const boardId = 'AAECAwQFBgcICQoLDA0ODw' as BoardId;
const headRevisionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const sourceRevisionId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const newRevisionId = '00112233-4455-4677-8899-aabbccddeeff';
const eventId = '11112233-4455-4677-8899-aabbccddeeff';

const actor = (
  grantId: string | null = null,
  scopes: readonly string[] = ['board.history.read', 'board.read', 'board.write'],
): ActorContextV1 => {
  const parsed = normalizeActorContextV1({
    principalKind: 'user',
    principalId: 'user_1',
    grantId,
    scopes,
  });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) throw new Error('invalid actor fixture');
  return parsed.data.value;
};

const principal = (
  grantId: string | null = null,
  scopes: readonly string[] = ['board.history.read', 'board.read', 'board.write'],
): Extract<ResolvedBoardPrincipalV1, { kind: 'user' }> => ({
  kind: 'user',
  actor: actor(grantId, scopes),
  userPk: 20n,
  sessionPk: 21n,
  familyPublicId: 'family_1',
  isBrowserCredential: true,
});

const accountApiKeyPrincipal = (): Extract<
  ResolvedBoardPrincipalV1,
  { kind: 'account_api_key' }
> => {
  const keyActor = normalizeActorContextV1({
    principalKind: 'service',
    principalId: 'key_public_1',
    grantId: null,
    scopes: [],
  });
  assert.equal(keyActor.ok, true);
  if (!keyActor.ok) throw new Error('invalid API-key actor fixture');
  const snapshot = {
    keyPk: '70',
    keyPublicId: 'key_public_1',
    ownerUserPk: '20',
    ownerPublicId: 'user_1',
    scopeMask: 8,
    scopes: ['board:write'] as const,
    expiresAt: Date.parse('2026-08-01T00:00:00.000Z'),
  };
  return {
    kind: 'account_api_key',
    actor: keyActor.data.value,
    ownerUserPk: 20n,
    apiKeyPk: 70n,
    scopeMask: snapshot.scopeMask,
    isBrowserCredential: false,
    [ACCOUNT_API_KEY_SNAPSHOT]: snapshot,
  };
};

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
    command: type === 'scene.clear' ? { type } : { type, sourceRevisionId },
  });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) throw new Error('invalid request fixture');
  return parsed.data.value;
};

const documentRequest = (
  requestId: string,
  idempotencyKey = 'mutation-key-0001',
  title = 'First',
  expectedRevisionId = headRevisionId,
): MutationRequestV2 => {
  const parsed = MutationRequestParserV2.parse({
    protocolVersion: 1,
    requestId,
    idempotencyKey,
    boardId,
    expectedRevisionId,
    command: {
      type: 'document.replace',
      document: {
        schemaVersion: 2,
        defaultPageId: 'page_1',
        pages: [
          {
            pageId: 'page_1',
            title,
            displayMode: 'fit-page',
            scene: { protocolVersion: 1, type: 'scene', root: null },
          },
        ],
      },
    },
  });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) throw new Error('invalid document request fixture');
  return parsed.data.value;
};

const artifactDocumentRequest = (
  requestId: string,
  idempotencyKey = 'mutation-key-artifact-0001',
): MutationRequestV2 => {
  const parsed = MutationRequestParserV2.parse({
    protocolVersion: 1,
    requestId,
    idempotencyKey,
    boardId,
    expectedRevisionId: headRevisionId,
    command: {
      type: 'document.replace',
      document: {
        schemaVersion: 2,
        defaultPageId: 'artifact_page',
        pages: [
          {
            pageId: 'artifact_page',
            title: 'Artifact',
            displayMode: 'fit-page',
            scene: {
              protocolVersion: 1,
              type: 'scene',
              root: {
                id: 'artifact_node',
                type: 'content.artifact',
                artifact: { artifactId: 'asset_1', versionId: 'version_1' },
                fallbackText: 'fallback',
              },
            },
          },
        ],
      },
    },
  });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) throw new Error('invalid artifact document fixture');
  return parsed.data.value;
};

const documentRequestV3 = (
  requestId: string,
  idempotencyKey = 'mutation-key-v3-0001',
): MutationRequestV3 => {
  const parsed = MutationRequestParserV3.parse({
    protocolVersion: 1,
    requestId,
    idempotencyKey,
    boardId,
    expectedRevisionId: headRevisionId,
    command: {
      type: 'document.replace',
      document: {
        schemaVersion: 3,
        format: 'standard_4_3',
        defaultPageId: 'page_1',
        pages: [
          {
            pageId: 'page_1',
            title: 'First',
            displayMode: 'fit-page',
            scene: { protocolVersion: 1, type: 'scene', root: null },
          },
        ],
      },
    },
  });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) throw new Error('invalid V3 document request fixture');
  return parsed.data.value;
};

const mediaDocumentRequest = (requestId: string): MutationRequestV2 => {
  const parsed = MutationRequestParserV2.parse({
    protocolVersion: 1,
    requestId,
    idempotencyKey: 'mutation-key-media-0001',
    boardId,
    expectedRevisionId: headRevisionId,
    command: {
      type: 'document.replace',
      document: {
        schemaVersion: 2,
        defaultPageId: 'page_1',
        pages: [
          {
            pageId: 'page_1',
            title: 'First',
            displayMode: 'fit-page',
            scene: {
              protocolVersion: 1,
              type: 'scene',
              root: {
                id: 'image_1',
                type: 'content.image',
                source: { type: 'media', mediaId: 'media_1' },
                alt: 'Media',
                fit: 'contain',
              },
            },
          },
        ],
      },
    },
  });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) throw new Error('invalid media document request fixture');
  return parsed.data.value;
};

const oversizedDocumentRequest = (): MutationRequestV2 =>
  ({
    protocolVersion: 1,
    requestId: 'request_document_too_large',
    idempotencyKey: 'mutation-key-0001',
    boardId,
    expectedRevisionId: headRevisionId,
    command: {
      type: 'document.replace',
      document: {
        schemaVersion: 2,
        defaultPageId: 'page_0',
        pages: Array.from({ length: 35 }, (_, pageIndex) => ({
          pageId: `page_${pageIndex}`,
          title: '',
          displayMode: 'fit-page',
          scene: {
            protocolVersion: 1,
            type: 'scene',
            root: {
              id: `root_${pageIndex}`,
              type: 'layout.split',
              direction: 'horizontal',
              gap: 0,
              children: Array.from({ length: 3 }, (_, nodeIndex) => ({
                node: {
                  id: `code_${pageIndex}_${nodeIndex}`,
                  type: 'content.code',
                  language: 'text',
                  code: 'x'.repeat(200_000),
                  showLineNumbers: false,
                  wrap: false,
                },
                weight: 1,
              })),
            },
          },
        })),
      },
    },
  }) as unknown as MutationRequestV2;

const overArtifactOccurrenceMutation = (code: 'A' | 'I'): unknown => {
  let remaining = MAX_ARTIFACT_REFERENCE_OCCURRENCES + 1;
  let pageIndex = 0;
  const pages = [];
  while (remaining > 0) {
    const count = Math.min(remaining, 200);
    const currentPageIndex = pageIndex;
    pageIndex += 1;
    pages.push({
      pageId: `reference_page_${currentPageIndex}`,
      title: '',
      displayMode: 'fit-page',
      scene: {
        protocolVersion: 1,
        type: 'scene',
        root: {
          id: `reference_root_${currentPageIndex}`,
          type: 'layout.canvas',
          width: 1_000,
          height: 10,
          children: Array.from({ length: count }, (_, nodeIndex) => ({
            node:
              code === 'A'
                ? {
                    id: `reference_a_${currentPageIndex}_${nodeIndex}`,
                    type: 'content.artifact',
                    artifact: { artifactId: 'asset_1', versionId: 'version_1' },
                    fallbackText: 'fallback',
                  }
                : {
                    id: `reference_i_${currentPageIndex}_${nodeIndex}`,
                    type: 'content.image',
                    source: {
                      type: 'artifact.resource',
                      artifact: { artifactId: 'asset_1', versionId: 'version_1' },
                      path: 'image.png',
                      sha256: 'a'.repeat(64),
                    },
                    alt: 'image',
                    fit: 'contain',
                  },
            x: nodeIndex,
            y: 0,
            width: 1,
            height: 1,
            zIndex: nodeIndex,
          })),
        },
      },
    });
    remaining -= count;
  }
  return {
    protocolVersion: 1,
    requestId: `request_reference_limit_${code.toLowerCase()}`,
    idempotencyKey: `mutation-key-reference-${code.toLowerCase()}`,
    boardId,
    expectedRevisionId: headRevisionId,
    command: {
      type: 'document.replace',
      document: {
        schemaVersion: 2,
        defaultPageId: 'reference_page_0',
        pages,
      },
    },
  };
};

const setup = async (
  type: 'scene.clear' | 'scene.restore' | 'document.replace',
  headSchemaVersion: '1.0.0' | '2.0.0' | '3.0.0' = '1.0.0',
  sourceSchemaVersion: '1.0.0' | '2.0.0' = '1.0.0',
  v3WriteEnabled = false,
  apiKey = false,
  headCheckpointOverrides: Record<string, unknown> = {},
) => {
  const calls: string[] = [];
  const checkpointCodec = new DocumentCheckpointCodec();
  let headCheckpoint =
    headSchemaVersion === '1.0.0'
      ? await checkpointCodec.encodeScene({
          protocolVersion: 1,
          type: 'scene',
          root: null,
        })
      : headSchemaVersion === '2.0.0'
        ? await checkpointCodec.encodeDocument({
            schemaVersion: 2,
            defaultPageId: 'head_page',
            pages: [
              {
                pageId: 'head_page',
                title: '',
                displayMode: 'fit-page',
                scene: { protocolVersion: 1, type: 'scene', root: null },
              },
            ],
          })
        : await checkpointCodec.encodeDocumentV3({
            schemaVersion: 3,
            format: 'wide_16_9',
            defaultPageId: 'head_page',
            pages: [
              {
                pageId: 'head_page',
                title: '',
                displayMode: 'fit-page',
                scene: { protocolVersion: 1, type: 'scene', root: null },
              },
            ],
          });
  const sourceCheckpoint =
    sourceSchemaVersion === '1.0.0'
      ? await checkpointCodec.encodeScene({
          protocolVersion: 1,
          type: 'scene',
          root: null,
        })
      : await checkpointCodec.encodeDocument({
          schemaVersion: 2,
          defaultPageId: 'source_page',
          pages: [
            {
              pageId: 'source_page',
              title: '',
              displayMode: 'fit-page',
              scene: { protocolVersion: 1, type: 'scene', root: null },
            },
          ],
        });
  let stored: Record<string, unknown> | null = null;
  let storedIdempotencyKey: string | null = null;
  let revisionWrites = 0;
  let sourceReads = 0;
  let referenceReads = 0;
  let idempotencyInserts = 0;
  let revisionInsertBinds: unknown[] | null = null;
  let eventInsertBinds: unknown[] | null = null;
  let revisionCatalogBinds: unknown[] | null = null;
  let artifactReferenceRows: Record<string, unknown>[] = [];
  let raceNextIdempotencyInsert = false;
  const connection = {
    async execute(sql: string, binds: unknown[] = []): Promise<[unknown, unknown]> {
      const normalized = sql.replace(/\s+/g, ' ').trim();
      calls.push(normalized);
      if (normalized.startsWith('INSERT INTO board_idempotency_records')) {
        idempotencyInserts += 1;
        if (raceNextIdempotencyInsert && stored !== null) {
          raceNextIdempotencyInsert = false;
          storedIdempotencyKey = String(binds[4]);
          return [{ affectedRows: 0, insertId: 60 } as ResultSetHeader, []];
        }
        if (stored !== null && storedIdempotencyKey === binds[4])
          return [{ affectedRows: 0, insertId: 60 } as ResultSetHeader, []];
        storedIdempotencyKey = String(binds[4]);
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
      if (normalized.includes('FROM board_idempotency_records'))
        return [stored === null || storedIdempotencyKey !== binds[3] ? [] : [stored], []];
      if (
        normalized.includes('FROM boards b') &&
        normalized.includes('JOIN board_revisions r') &&
        normalized.includes('r.revision_id = ?')
      ) {
        sourceReads += 1;
        const requestedRevision = Buffer.isBuffer(binds[1])
          ? (binds[1] as Buffer).toString('hex')
          : '';
        const isReplayRevision = requestedRevision === newRevisionId.replaceAll('-', '');
        const replayBinds = revisionInsertBinds;
        return [
          [
            {
              boardPk: '50',
              revisionPk: isReplayRevision ? '71' : '65',
              revisionId: Buffer.from(
                (isReplayRevision ? newRevisionId : sourceRevisionId).replaceAll('-', ''),
                'hex',
              ),
              revisionNumber: isReplayRevision ? '3' : '1',
              sceneSchemaVersion: isReplayRevision
                ? String(replayBinds?.[7])
                : sourceCheckpoint.schemaVersion,
              sceneCodec: isReplayRevision ? String(replayBinds?.[8]) : sourceCheckpoint.codec,
              scenePayload: isReplayRevision
                ? (replayBinds?.[9] as Buffer)
                : sourceCheckpoint.payload,
              sceneCanonicalBytes: isReplayRevision
                ? Number(replayBinds?.[10])
                : sourceCheckpoint.canonicalBytes,
              sceneStoredBytes: isReplayRevision
                ? Number(replayBinds?.[11])
                : sourceCheckpoint.storedBytes,
              sceneSha256: isReplayRevision
                ? (replayBinds?.[12] as Buffer)
                : sourceCheckpoint.sha256,
            },
          ],
          [],
        ];
      }
      if (normalized.includes('FROM board_revision_artifact_refs')) {
        referenceReads += 1;
        return [artifactReferenceRows.map((row) => ({ ...row })), []];
      }
      if (normalized.includes('FROM board_revision_media_refs')) {
        return [[], []];
      }
      if (
        normalized.includes('FROM boards b') &&
        normalized.includes('JOIN board_heads h') &&
        normalized.endsWith('FOR UPDATE')
      ) {
        return [
          [
            {
              boardPk: '50',
              archivedAt: null,
              headRevisionPk: '70',
              headRevisionId: Buffer.from(headRevisionId.replaceAll('-', ''), 'hex'),
              headRevisionNumber: '2',
              lastEventSequence: '2',
              sceneSchemaVersion: headCheckpoint.schemaVersion,
              sceneCodec: headCheckpoint.codec,
              scenePayload: headCheckpoint.payload,
              sceneCanonicalBytes: headCheckpoint.canonicalBytes,
              sceneStoredBytes: headCheckpoint.storedBytes,
              sceneSha256: headCheckpoint.sha256,
              ...headCheckpointOverrides,
            },
          ],
          [],
        ];
      }
      if (
        normalized.includes('FROM board_revision_catalog c') &&
        normalized.includes('r.revision_pk = ?')
      ) {
        sourceReads += 1;
        return [
          [
            {
              revisionPk: '65',
              revisionId: Buffer.from(sourceRevisionId.replaceAll('-', ''), 'hex'),
              revisionNumber: '1',
              sceneSchemaVersion: sourceCheckpoint.schemaVersion,
              sceneCodec: sourceCheckpoint.codec,
              scenePayload: sourceCheckpoint.payload,
              sceneCanonicalBytes: sourceCheckpoint.canonicalBytes,
              sceneStoredBytes: sourceCheckpoint.storedBytes,
              sceneSha256: sourceCheckpoint.sha256,
            },
          ],
          [],
        ];
      }
      if (normalized.startsWith('INSERT INTO board_revisions')) {
        revisionWrites += 1;
        revisionInsertBinds = [...binds];
        return [{ affectedRows: 1, insertId: 71 } as ResultSetHeader, []];
      }
      if (normalized.startsWith('INSERT INTO board_revision_payloads')) {
        return [{ affectedRows: 1, insertId: 0 } as ResultSetHeader, []];
      }
      if (normalized.startsWith('INSERT INTO board_revision_artifact_refs')) {
        artifactReferenceRows = [];
        for (let index = 0; index < binds.length; index += 5) {
          artifactReferenceRows.push({
            artifactId: binds[index + 1],
            artifactVersionId: binds[index + 2],
            referenceCode: binds[index + 3],
            occurrenceCount: binds[index + 4],
          });
        }
        return [{ affectedRows: artifactReferenceRows.length, insertId: 0 } as ResultSetHeader, []];
      }
      if (normalized.startsWith('UPDATE board_revision_catalog')) {
        return [{ affectedRows: 1, insertId: 0 } as ResultSetHeader, []];
      }
      if (normalized.startsWith('INSERT INTO board_revision_catalog')) {
        revisionCatalogBinds = [...binds];
        return [{ affectedRows: 1, insertId: 0 } as ResultSetHeader, []];
      }
      if (normalized.startsWith('UPDATE board_heads')) {
        return [{ affectedRows: 1, insertId: 0 } as ResultSetHeader, []];
      }
      if (normalized.startsWith('UPDATE boards SET')) {
        return [{ affectedRows: 1, insertId: 0 } as ResultSetHeader, []];
      }
      if (normalized.startsWith('INSERT INTO board_event_outbox')) {
        eventInsertBinds = [...binds];
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
      if (
        normalized.includes('FROM boards b') &&
        normalized.includes('JOIN board_event_outbox e')
      ) {
        return [
          [
            {
              boardId,
              revisionId: Buffer.from(newRevisionId.replaceAll('-', ''), 'hex'),
              eventId: Buffer.from(eventId.replaceAll('-', ''), 'hex'),
            },
          ],
          [],
        ];
      }
      throw new Error(`unexpected SQL: ${normalized}`);
    },
  } as unknown as PoolConnection;
  const apiKeyPrincipal = accountApiKeyPrincipal();
  const context: AuthorizedBoardContextV1 = {
    actor: apiKey ? apiKeyPrincipal.actor : actor(),
    ownerUserPk: 20n,
    accountUserPk: 20n,
    access: apiKey
      ? { kind: 'api_key', ownerUserPk: 20n, apiKeyPk: 70n }
      : { kind: 'owner', ownerUserPk: 20n },
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
      assert.equal(input.operation, type);
      assert.equal(input.boardId, boardId);
      assert.equal(input.isolation, 'READ_COMMITTED_WRITE');
      const before = stored;
      const beforeIdempotencyKey = storedIdempotencyKey;
      const beforeArtifactReferenceRows = artifactReferenceRows.map((row) => ({ ...row }));
      try {
        return await apply(connection, { ...context, actor: input.principal.actor });
      } catch (error) {
        stored = before;
        storedIdempotencyKey = beforeIdempotencyKey;
        artifactReferenceRows = beforeArtifactReferenceRows;
        throw error;
      }
    },
  };
  const generated = [newRevisionId, eventId, '22222233-4455-4677-8899-aabbccddeeff'];
  const createService = (enabled: boolean) =>
    new BoardMutationService(
      policy,
      new DocumentCheckpointCodec(),
      {
        now: () => new Date('2026-07-16T12:00:00.000Z'),
        generateUuid: () => generated.shift() ?? '33332233-4455-4677-8899-aabbccddeeff',
      },
      undefined,
      undefined,
      enabled,
    );
  const advanceHeadToV3 = async () => {
    headCheckpoint = await checkpointCodec.encodeDocumentV3({
      schemaVersion: 3,
      format: 'wide_16_9',
      defaultPageId: 'head_page',
      pages: [
        {
          pageId: 'head_page',
          title: '',
          displayMode: 'fit-page',
          scene: { protocolVersion: 1, type: 'scene', root: null },
        },
      ],
    });
  };
  return {
    calls,
    revisionWrites: () => revisionWrites,
    sourceReads: () => sourceReads,
    referenceReads: () => referenceReads,
    artifactReferenceRows: () => artifactReferenceRows.map((row) => ({ ...row })),
    setArtifactReferenceRows: (rows: readonly Record<string, unknown>[]) => {
      artifactReferenceRows = rows.map((row) => ({ ...row }));
    },
    raceNextIdempotencyInsert: () => {
      raceNextIdempotencyInsert = true;
    },
    idempotencyInserts: () => idempotencyInserts,
    revisionInsertBinds: () => revisionInsertBinds,
    eventInsertBinds: () => eventInsertBinds,
    revisionCatalogBinds: () => revisionCatalogBinds,
    apiKeyPrincipal,
    service: createService(v3WriteEnabled),
    createService,
    advanceHeadToV3,
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
  const revisionIndex = value.calls.findIndex((call) =>
    call.startsWith('INSERT INTO board_revisions'),
  );
  const headIndex = value.calls.findIndex((call) => call.startsWith('UPDATE board_heads'));
  const eventIndex = value.calls.findIndex((call) =>
    call.startsWith('INSERT INTO board_event_outbox'),
  );
  const completeIndex = value.calls.findIndex((call) =>
    call.startsWith('UPDATE board_idempotency_records'),
  );
  assert.ok(revisionIndex < headIndex && headIndex < eventIndex && eventIndex < completeIndex);
});

test('locks and validates one detached-first effective head checkpoint before a new mutation', async () => {
  const value = await setup('scene.clear');
  await value.service.applySceneMutation({
    principal: principal(),
    request: request('scene.clear', 'request_detached_head_1'),
  });
  const sql = value.calls.find(
    (call) => call.includes('JOIN board_heads h') && call.endsWith('FOR UPDATE'),
  );
  assert.ok(sql);
  assert.match(
    sql,
    /LEFT JOIN board_revision_payloads p ON p\.revision_pk = hr\.revision_pk AND p\.state = 'available'/u,
  );
  assert.equal((sql.match(/CASE WHEN p\.revision_pk IS NOT NULL/gu) ?? []).length, 6);

  const partial = await setup('scene.clear', '1.0.0', '1.0.0', false, false, {
    scenePayload: null,
  });
  await assert.rejects(
    partial.service.applySceneMutation({
      principal: principal(),
      request: request('scene.clear', 'request_partial_head_1'),
    }),
    (error: unknown) =>
      error instanceof BoardPersistenceError && error.category === 'row_integrity',
  );
  assert.equal(partial.idempotencyInserts(), 0);
  assert.equal(partial.revisionWrites(), 0);
});

test('attributes API-key scene mutation to the owner account without classifying it as system', async () => {
  const value = await setup('scene.clear', '1.0.0', '1.0.0', false, true);
  await value.service.applySceneMutation({
    principal: value.apiKeyPrincipal,
    request: request('scene.clear', 'request_key_mutation_1'),
  });
  assert.deepEqual(value.revisionCatalogBinds()?.slice(0, 5), ['50', '71', 3, '20', 'owner']);
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
    (error: unknown) =>
      error instanceof BoardContractError &&
      error.boardError.code === 'IDEMPOTENCY_KEY_REUSED' &&
      'reason' in error.boardError.details &&
      error.boardError.details?.reason === 'expected_revision_changed',
  );
  assert.equal(value.revisionWrites(), 1);
});

test('restore copies one verified immutable source and replay revalidates revision integrity', async () => {
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
  assert.equal(value.sourceReads(), 3);
  assert.equal(value.referenceReads(), 3);
  assert.equal(value.revisionWrites(), 1);
});

test('ordinary replay rejects missing, extra, stale-code, or miscounted artifact rows', async () => {
  const corruptions: readonly {
    name: string;
    apply(rows: readonly Record<string, unknown>[]): readonly Record<string, unknown>[];
  }[] = [
    { name: 'missing', apply: () => [] },
    {
      name: 'extra',
      apply: (rows) => [
        ...rows,
        {
          artifactId: 'asset_2',
          artifactVersionId: 'version_1',
          referenceCode: 'A',
          occurrenceCount: 1,
        },
      ],
    },
    {
      name: 'stale-code',
      apply: (rows) => rows.map((row) => ({ ...row, referenceCode: 'I' })),
    },
    {
      name: 'miscounted',
      apply: (rows) => rows.map((row) => ({ ...row, occurrenceCount: 2 })),
    },
  ];

  for (const corruption of corruptions) {
    const value = await setup('document.replace');
    await value.service.applyDocumentMutation({
      principal: principal(),
      request: artifactDocumentRequest(`request_artifact_${corruption.name}_first`),
    });
    value.setArtifactReferenceRows(corruption.apply(value.artifactReferenceRows()));

    await assert.rejects(
      value.service.applyDocumentMutation({
        principal: principal(),
        request: artifactDocumentRequest(`request_artifact_${corruption.name}_replay`),
      }),
      (error: unknown) =>
        error instanceof BoardPersistenceError && error.category === 'row_integrity',
    );
    assert.equal(value.revisionWrites(), 1);
    assert.equal(value.referenceReads(), 1);
  }
});

test('insert-race replay rejects a corrupt artifact relation without new durable effects', async () => {
  const value = await setup('document.replace');
  await value.service.applyDocumentMutation({
    principal: principal(),
    request: artifactDocumentRequest('request_artifact_race_first'),
  });
  value.setArtifactReferenceRows([]);
  value.raceNextIdempotencyInsert();

  await assert.rejects(
    value.service.applyDocumentMutation({
      principal: principal(),
      request: artifactDocumentRequest(
        'request_artifact_race_replay',
        'mutation-key-artifact-race',
      ),
    }),
    (error: unknown) =>
      error instanceof BoardPersistenceError && error.category === 'row_integrity',
  );
  assert.equal(value.revisionWrites(), 1);
  assert.equal(value.referenceReads(), 1);
  assert.equal(
    value.calls.filter((call) => call.startsWith('INSERT INTO board_event_outbox')).length,
    1,
  );
});

test('document.replace promotes a v1 head to one exact v2 checkpoint, event, and replayable result', async () => {
  const value = await setup('document.replace');
  const requestValue = documentRequest('request_document_1');
  const result = await value.service.applyDocumentMutation({
    principal: principal(),
    request: requestValue,
  });
  assert.equal(MutationResultParserV2.parse(result).ok, true);
  assert.equal(result.result.type, 'document.replace');
  if (result.result.type !== 'document.replace' || requestValue.command.type !== 'document.replace')
    return;
  assert.deepEqual(result.result.document, requestValue.command.document);
  assert.equal(result.result.originType, 'document.replace');
  assert.equal(result.result.sourceRevisionId, null);
  assert.equal(value.revisionInsertBinds()?.[5], 'D');
  assert.equal(value.revisionInsertBinds()?.[7], '2.0.0');
  const eventPayload = value.eventInsertBinds()?.[4];
  assert.ok(Buffer.isBuffer(eventPayload));
  const event = BoardEventEnvelopeParserV2.parseBytes(eventPayload);
  assert.equal(event.ok, true);
  if (event.ok) {
    assert.equal(event.data.value.data.type, 'board.revision.created');
    if (event.data.value.data.type === 'board.revision.created') {
      assert.equal(event.data.value.data.originType, 'document.replace');
      assert.equal(event.data.value.data.sourceRevisionId, null);
    }
  }
  const replay = await value.service.applyDocumentMutation({
    principal: principal(),
    request: documentRequest('request_document_2'),
  });
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.result, result.result);
  assert.equal(value.revisionWrites(), 1);
});

test('document.replace V3 writes exactly one format-bearing checkpoint when the rollout gate is enabled', async () => {
  const value = await setup('document.replace', '2.0.0', '1.0.0', true);
  const requestValue = documentRequestV3('request_document_v3_1');
  const result = await value.service.applyDocumentMutation({
    principal: principal(),
    request: requestValue,
  });
  assert.equal(MutationResultParserV3.parse(result).ok, true);
  assert.equal(result.result.type, 'document.replace');
  if (result.result.type !== 'document.replace') return;
  assert.equal(result.result.document.schemaVersion, 3);
  assert.equal(result.result.document.format, 'standard_4_3');
  assert.equal(value.revisionInsertBinds()?.[7], '3.0.0');
  assert.equal(value.revisionWrites(), 1);
  assert.equal(value.idempotencyInserts(), 1);
});

test('document.replace V3 replay remains stable after the new-write rollout gate is disabled', async () => {
  const value = await setup('document.replace', '2.0.0', '1.0.0', true);
  const first = await value.service.applyDocumentMutation({
    principal: principal(),
    request: documentRequestV3('request_document_v3_enabled'),
  });
  const disabledService = value.createService(false);
  const replay = await disabledService.applyDocumentMutation({
    principal: principal(),
    request: documentRequestV3('request_document_v3_replay'),
  });
  assert.equal(replay.replayed, true);
  assert.equal(replay.requestId, 'request_document_v3_replay');
  assert.deepEqual(replay.result, first.result);
  assert.equal(value.revisionWrites(), 1);
  assert.equal(value.idempotencyInserts(), 1);
  assert.equal(
    value.calls.filter((call) => call.startsWith('INSERT INTO board_event_outbox')).length,
    1,
  );

  await assert.rejects(
    disabledService.applyDocumentMutation({
      principal: principal(),
      request: documentRequestV3('request_document_v3_disabled', 'mutation-key-v3-new'),
    }),
    (error: unknown) =>
      error instanceof BoardContractError &&
      error.boardError.code === 'SERVICE_UNAVAILABLE' &&
      error.boardError.retryable === true &&
      error.boardError.httpStatusHint === 503,
  );
  assert.equal(value.revisionWrites(), 1);
  assert.equal(value.idempotencyInserts(), 1);
  assert.equal(
    value.calls.filter((call) => call.startsWith('INSERT INTO board_event_outbox')).length,
    1,
  );
});

test('committed V2 mutation replays after the current head advances to V3', async () => {
  const value = await setup('document.replace', '2.0.0');
  const first = await value.service.applyDocumentMutation({
    principal: principal(),
    request: documentRequest('request_v2_before_v3'),
  });
  await value.advanceHeadToV3();

  const replay = await value.service.applyDocumentMutation({
    principal: principal(),
    request: documentRequest('request_v2_replay_after_v3'),
  });
  assert.equal(replay.replayed, true);
  assert.equal(replay.requestId, 'request_v2_replay_after_v3');
  assert.deepEqual(replay.result, first.result);

  const assertReuseReason = async (
    input: Parameters<BoardMutationService['applyDocumentMutation']>[0],
    reason: 'grant_changed' | 'scopes_changed' | 'expected_revision_changed' | 'payload_changed',
  ) =>
    assert.rejects(
      value.service.applyDocumentMutation(input),
      (error: unknown) =>
        error instanceof BoardContractError &&
        error.boardError.code === 'IDEMPOTENCY_KEY_REUSED' &&
        'reason' in error.boardError.details &&
        error.boardError.details.reason === reason,
    );

  await assertReuseReason(
    {
      principal: principal('grant_1'),
      request: documentRequest('request_v2_grant_changed_after_v3'),
    },
    'grant_changed',
  );
  await assertReuseReason(
    {
      principal: principal(null, ['board.read', 'board.write']),
      request: documentRequest('request_v2_scopes_changed_after_v3'),
    },
    'scopes_changed',
  );
  await assertReuseReason(
    {
      principal: principal(),
      request: documentRequest(
        'request_v2_expected_changed_after_v3',
        'mutation-key-0001',
        'First',
        sourceRevisionId,
      ),
    },
    'expected_revision_changed',
  );
  await assertReuseReason(
    {
      principal: principal(),
      request: documentRequest(
        'request_v2_payload_changed_after_v3',
        'mutation-key-0001',
        'Changed',
      ),
    },
    'payload_changed',
  );

  await assert.rejects(
    value.service.applyDocumentMutation({
      principal: principal(),
      request: documentRequest('request_new_v2_after_v3', 'mutation-key-v2-new'),
    }),
    (error: unknown) =>
      error instanceof BoardContractError && error.boardError.code === 'UPGRADE_REQUIRED',
  );
  assert.equal(value.revisionWrites(), 1);
  assert.equal(value.idempotencyInserts(), 1);
  assert.equal(
    value.calls.filter((call) => call.startsWith('INSERT INTO board_event_outbox')).length,
    1,
  );
});

test('new legacy writer is rejected against a V3 head after replay lookup without durable writes', async () => {
  const value = await setup('scene.clear', '3.0.0');
  await assert.rejects(
    value.service.applySceneMutation({
      principal: principal(),
      request: request('scene.clear', 'request_legacy_on_v3'),
    }),
    (error: unknown) =>
      error instanceof BoardContractError &&
      error.boardError.code === 'UPGRADE_REQUIRED' &&
      error.boardError.details.headSchemaVersion === 3 &&
      error.boardError.details.requestedDocumentSchemaVersion === 1,
  );
  assert.equal(
    value.calls.some((call) => call.includes('FROM board_idempotency_records')),
    true,
  );
  assert.equal(value.idempotencyInserts(), 0);
  assert.equal(value.sourceReads(), 0);
  assert.equal(value.revisionWrites(), 0);
});

test('deny-all media gate rejects before idempotency, revision, ref, head, or outbox writes', async () => {
  const value = await setup('document.replace');
  await assert.rejects(
    value.service.applyDocumentMutation({
      principal: principal(),
      request: mediaDocumentRequest('request_document_media'),
    }),
    (error: unknown) =>
      error instanceof BoardContractError &&
      error.boardError.code === 'INVALID_MEDIA_REFERENCE' &&
      error.boardError.httpStatusHint === 400 &&
      JSON.stringify(error.boardError.details) === JSON.stringify({ reason: 'unavailable' }),
  );
  assert.equal(value.idempotencyInserts(), 0);
  assert.equal(value.revisionWrites(), 0);
  assert.equal(
    value.calls.some(
      (call) =>
        call.startsWith('INSERT INTO board_revision_media_refs') ||
        call.startsWith('UPDATE board_heads') ||
        call.startsWith('INSERT INTO board_event_outbox'),
    ),
    false,
  );
});

test('rejects an oversized document before authorization transaction or any durable side effect', async () => {
  const value = await setup('document.replace');
  await assert.rejects(
    value.service.applyDocumentMutation({
      principal: principal(),
      request: oversizedDocumentRequest(),
    }),
    (error: unknown) =>
      error instanceof BoardContractError &&
      error.boardError.code === 'PAYLOAD_TOO_LARGE' &&
      'scope' in error.boardError.details &&
      error.boardError.details.scope === 'document',
  );
  assert.equal(value.calls.length, 0);
  assert.equal(value.idempotencyInserts(), 0);
  assert.equal(value.revisionWrites(), 0);
});

test('rejects 501 cross-page A or I occurrences as INVALID_DOCUMENT before durable effects', async () => {
  const value = await setup('document.replace');
  for (const code of ['A', 'I'] as const) {
    await assert.rejects(
      async () => {
        const parsed = MutationRequestParserV2.parse(overArtifactOccurrenceMutation(code));
        if (!parsed.ok) throw new BoardContractError(parsed.error);
        await value.service.applyDocumentMutation({
          principal: principal(),
          request: parsed.data.value,
        });
      },
      (error: unknown) =>
        error instanceof BoardContractError &&
        error.boardError.code === 'INVALID_DOCUMENT' &&
        error.boardError.httpStatusHint === 422,
    );
  }
  assert.equal(value.idempotencyInserts(), 0);
  assert.equal(value.revisionWrites(), 0);
  assert.equal(
    value.calls.filter((call) => call.startsWith('INSERT INTO board_event_outbox')).length,
    0,
  );
});

test('a v2 head rejects legacy scene writes before idempotency, revision, or outbox insertion', async () => {
  const value = await setup('scene.clear', '2.0.0');
  await assert.rejects(
    value.service.applySceneMutation({
      principal: principal(),
      request: request('scene.clear', 'request_legacy_on_v2'),
    }),
    (error: unknown) =>
      error instanceof BoardContractError &&
      error.boardError.code === 'DOCUMENT_VERSION_MISMATCH' &&
      error.boardError.details.headSchemaVersion === 2 &&
      error.boardError.details.commandSchemaVersion === 1,
  );
  assert.equal(value.idempotencyInserts(), 0);
  assert.equal(value.revisionWrites(), 0);
  assert.equal(
    value.calls.some((call) => call.startsWith('INSERT INTO board_event_outbox')),
    false,
  );
});

test('restore deterministically preserves v2 sources and wraps retained v1 sources over v2 heads', async () => {
  for (const [headVersion, sourceVersion] of [
    ['2.0.0', '1.0.0'],
    ['1.0.0', '2.0.0'],
    ['2.0.0', '2.0.0'],
  ] as const) {
    const value = await setup('scene.restore', headVersion, sourceVersion);
    const result = await value.service.applySceneMutation({
      principal: principal(),
      request: request(
        'scene.restore',
        `request_restore_${headVersion.replaceAll('.', '')}_${sourceVersion.replaceAll('.', '')}`,
      ),
    });
    assert.equal(result.result.type, 'scene.restore');
    assert.equal(value.revisionInsertBinds()?.[4], '65');
    assert.equal(value.revisionInsertBinds()?.[5], 'S');
    assert.equal(value.revisionInsertBinds()?.[7], '2.0.0');
  }
});
