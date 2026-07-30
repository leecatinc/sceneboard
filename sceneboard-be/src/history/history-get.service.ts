import {
  adaptLegacySceneToDocumentV2,
  BoardOperationResultParserV1,
  BoardOperationResultParserV2,
  BoardOperationResultParserV3,
  PrincipalIdParserV1,
  projectDocumentV2ToV3,
  projectDocumentV3ToV2,
  type BoardId,
  type BoardOperationRequestV1,
  type BoardOperationResultV1,
  type HistoryEntryV1,
  type PrincipalId,
  type RequestId,
  type RevisionId,
  type TimestampV1,
} from '@sceneboard/board-schema';
import type { PoolConnection, RowDataPacket } from 'mysql2/promise';

import { BoardContractError } from '../common/errors/app-error.js';
import { BoardPersistenceError } from '../common/errors/board-persistence.error.js';
import { formatPublicUuidV4, parsePublicUuidV4 } from '../common/ids/public-uuid.storage.js';
import { parseMysqlTimestampUtc } from '../common/time/mysql-timestamp.js';
import type { BoardAccessPolicy, ResolvedBoardPrincipalV1 } from '../grants/board-access.policy.js';
import {
  decodeMediaIdFromStorage,
  decodePageIdFromStorage,
} from '../media/media-reference.types.js';
import { RevisionMediaReferenceExtractor } from '../media/revision-media-reference.extractor.js';
import { DocumentCheckpointCodec } from '../revisions/document-checkpoint.codec.js';
import {
  extractDocumentArtifactReferences,
  extractSceneArtifactReferences,
} from '../revisions/scene-artifact-reference.extractor.js';
import { SnapshotCompositionService } from '../revisions/snapshot-composition.service.js';
import {
  historyGetMetadata,
  retainedHistoryGetMetadata,
  type HistoryHttpMetadataV1,
} from './history-adapter-metadata.js';

export type HistoryGetRequestV1 = BoardOperationRequestV1 & {
  protocolVersion: 1;
  requestId: RequestId;
  type: 'history.get';
  boardId: BoardId;
  revisionId: RevisionId;
  documentSchemaVersion?: 1 | 2 | 3;
};

interface HistoryGetRow extends RowDataPacket {
  revisionPk: string;
  revisionId: Buffer;
  revisionNumber: string;
  revisionCreatedAt: string;
  previousRevisionId: Buffer | null;
  sourceRevisionId: Buffer | null;
  originCode: string;
  actorKind: string;
  actorPrincipalId: string;
  label: string;
  nextRevisionId: Buffer | null;
  latestRevisionId: Buffer;
  sceneSchemaVersion: string;
  sceneCodec: string;
  scenePayload: Buffer;
  sceneCanonicalBytes: number;
  sceneStoredBytes: number;
  sceneSha256: Buffer;
  lastEventSequence: string;
  truncatedBefore: number;
  oldestRetainedRevisionId: Buffer;
  actorAccountPk: string | null;
  actorClass: string;
}

interface ReferenceRow extends RowDataPacket {
  artifactId: string;
  artifactVersionId: string;
  referenceCode: string;
  occurrenceCount: number;
}

interface MediaReferenceRow extends RowDataPacket {
  mediaId: Buffer;
  firstPageId: Buffer;
  ordinal: number;
}

const notFound = (): BoardContractError =>
  new BoardContractError({
    protocolVersion: 1,
    type: 'board.error',
    code: 'BOARD_NOT_FOUND',
    message: 'Board not found',
    category: 'not_found',
    retryable: false,
    httpStatusHint: 404,
    details: null,
  });

const storedRevisionId = (value: Uint8Array): RevisionId => formatPublicUuidV4(value) as RevisionId;
const positive = (value: string): number => {
  if (!/^[1-9][0-9]{0,15}$/.test(value)) throw new BoardPersistenceError('row_integrity');
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new BoardPersistenceError('row_integrity');
  return parsed;
};
const timestamp = (value: string): TimestampV1 => {
  try {
    return parseMysqlTimestampUtc(value).toISOString() as TimestampV1;
  } catch (error) {
    throw new BoardPersistenceError('row_integrity', error);
  }
};
const principalId = (value: string): PrincipalId => {
  const parsed = PrincipalIdParserV1.parse(value);
  if (!parsed.ok) throw new BoardPersistenceError('row_integrity');
  return parsed.data.value;
};
const principalKind = (value: string): 'user' | 'mcp_client' | 'service' => {
  if (value === 'U') return 'user';
  if (value === 'M') return 'mcp_client';
  if (value === 'S') return 'service';
  throw new BoardPersistenceError('row_integrity');
};
const originType = (
  value: string,
): 'board.create' | 'scene.replace' | 'scene.clear' | 'scene.restore' | 'document.replace' => {
  if (value === 'C') return 'board.create';
  if (value === 'R') return 'scene.replace';
  if (value === 'L') return 'scene.clear';
  if (value === 'S') return 'scene.restore';
  if (value === 'D') return 'document.replace';
  throw new BoardPersistenceError('row_integrity');
};

export class HistoryGetService {
  constructor(
    private readonly accessPolicy: BoardAccessPolicy,
    private readonly checkpoints: DocumentCheckpointCodec,
    private readonly snapshots: SnapshotCompositionService,
    private readonly emitRetainedMetadata = false,
    private readonly mediaReferences = new RevisionMediaReferenceExtractor(),
  ) {}

  async get(input: {
    principal: ResolvedBoardPrincipalV1;
    request: HistoryGetRequestV1;
  }): Promise<BoardOperationResultV1> {
    return (await this.getWithMetadata(input)).result;
  }

  async getWithMetadata(input: {
    principal: ResolvedBoardPrincipalV1;
    request: HistoryGetRequestV1;
  }): Promise<{ result: BoardOperationResultV1; metadata: HistoryHttpMetadataV1 }> {
    return this.accessPolicy.withAuthorizedBoardTransaction(
      {
        principal: input.principal,
        operation: 'history.get',
        boardId: input.request.boardId,
        isolation: 'REPEATABLE_READ_CUT',
      },
      async (connection, context) => {
        let revisionBytes: Buffer;
        try {
          revisionBytes = Buffer.from(parsePublicUuidV4(input.request.revisionId));
        } catch {
          throw notFound();
        }
        const row = await this.readRevision(connection, input.request.boardId, revisionBytes);
        const selectedRevisionId = storedRevisionId(row.revisionId);
        if (selectedRevisionId !== input.request.revisionId)
          throw new BoardPersistenceError('row_integrity');
        const revisionNumber = positive(row.revisionNumber);
        const lastEventSequence = positive(row.lastEventSequence);
        const decoded = await this.checkpoints.decode({
          schemaVersion: row.sceneSchemaVersion,
          codec: row.sceneCodec,
          payload: row.scenePayload,
          canonicalBytes: row.sceneCanonicalBytes,
          storedBytes: row.sceneStoredBytes,
          sha256: row.sceneSha256,
        });
        if (input.request.documentSchemaVersion === 1 && decoded.kind === 'document') {
          throw new BoardContractError({
            protocolVersion: 1,
            type: 'board.error',
            code: 'PROTOCOL_VERSION_MISMATCH',
            message: 'Document history requires a document-capable client',
            category: 'protocol',
            retryable: false,
            httpStatusHint: 409,
            details: {
              reason: 'schema_revision',
              supportedMajor: 1,
              receivedMajor: 1,
              field: 'documentSchemaVersion',
            },
          });
        }
        await this.assertReferences(connection, row.revisionPk, decoded);
        await this.assertMediaReferences(
          connection,
          row.revisionPk,
          input.request.boardId,
          selectedRevisionId,
          decoded,
        );
        const revision = {
          revisionId: selectedRevisionId,
          revisionNumber,
          createdAt: timestamp(row.revisionCreatedAt),
          previousRevisionId:
            row.previousRevisionId === null ? null : storedRevisionId(row.previousRevisionId),
          originType: originType(row.originCode),
          sourceRevisionId:
            row.sourceRevisionId === null ? null : storedRevisionId(row.sourceRevisionId),
          actor: {
            principalKind: principalKind(row.actorKind),
            principalId: principalId(row.actorPrincipalId),
          },
        };
        const composition = {
          actor: context.actor,
          boardId: input.request.boardId,
          revision,
          lastEventSequence,
        };
        const snapshot =
          input.request.documentSchemaVersion === 3
            ? await this.snapshots.composeDocument(connection, {
                ...composition,
                checkpoint: {
                  kind: 'document',
                  document:
                    decoded.kind === 'scene'
                      ? projectDocumentV2ToV3(
                          adaptLegacySceneToDocumentV2({
                            boardId: input.request.boardId,
                            scene: decoded.scene,
                          }),
                        )
                      : decoded.document.schemaVersion === 2
                        ? projectDocumentV2ToV3(decoded.document)
                        : decoded.document,
                  canonicalBytes: decoded.canonicalBytes,
                },
              })
            : input.request.documentSchemaVersion === 2 || decoded.kind === 'document'
              ? await this.snapshots.composeDocument(connection, {
                  ...composition,
                  checkpoint: {
                    kind: 'document',
                    document:
                      decoded.kind === 'scene'
                        ? adaptLegacySceneToDocumentV2({
                            boardId: input.request.boardId,
                            scene: decoded.scene,
                          })
                        : decoded.document.schemaVersion === 3
                          ? projectDocumentV3ToV2(decoded.document)
                          : decoded.document,
                    canonicalBytes: decoded.canonicalBytes,
                  },
                })
              : await this.snapshots.compose(connection, {
                  ...composition,
                  checkpoint: decoded,
                });
        const entry: HistoryEntryV1 = {
          revision: {
            revisionId: revision.revisionId,
            revisionNumber: revision.revisionNumber,
            createdAt: revision.createdAt,
          },
          previousRevisionId: revision.previousRevisionId,
          originType: revision.originType,
          sourceRevisionId: revision.sourceRevisionId,
          actor: revision.actor,
        };
        const parser =
          'document' in snapshot
            ? snapshot.document.schemaVersion === 3
              ? BoardOperationResultParserV3
              : BoardOperationResultParserV2
            : BoardOperationResultParserV1;
        const parsed = parser.parse({
          protocolVersion: 1,
          type: 'board.operation.result',
          requestId: input.request.requestId,
          replayed: false,
          result: {
            type: 'history.get',
            entry,
            snapshot,
          },
        });
        if (!parsed.ok) throw new BoardPersistenceError('row_integrity');
        return {
          result: parsed.data.value,
          metadata: this.emitRetainedMetadata
            ? retainedHistoryGetMetadata({
                source: {
                  entry,
                  actorLabel:
                    row.actorClass === 'system'
                      ? 'system'
                      : input.principal.kind === 'user' &&
                          row.actorAccountPk === input.principal.userPk.toString()
                        ? 'self'
                        : row.actorClass === 'owner'
                          ? 'owner'
                          : 'editor',
                  schemaVersion:
                    row.sceneSchemaVersion === '1.0.0' ||
                    row.sceneSchemaVersion === '2.0.0' ||
                    row.sceneSchemaVersion === '3.0.0'
                      ? row.sceneSchemaVersion === '3.0.0' &&
                        input.request.documentSchemaVersion !== 3
                        ? '2.0.0'
                        : row.sceneSchemaVersion
                      : (() => {
                          throw new BoardPersistenceError('row_integrity');
                        })(),
                },
                boundary: {
                  truncatedBefore: row.truncatedBefore === 1,
                  oldestRetainedRevisionId: storedRevisionId(row.oldestRetainedRevisionId),
                },
                previous:
                  row.previousRevisionId === null
                    ? row.truncatedBefore === 1
                      ? { kind: 'truncated' }
                      : null
                    : { kind: 'revision', revisionId: storedRevisionId(row.previousRevisionId) },
                nextRevisionId:
                  row.nextRevisionId === null ? null : storedRevisionId(row.nextRevisionId),
                latestRevisionId: storedRevisionId(row.latestRevisionId),
              })
            : historyGetMetadata({
                entry,
                label: row.label,
                nextRevisionId:
                  row.nextRevisionId === null ? null : storedRevisionId(row.nextRevisionId),
                latestRevisionId: storedRevisionId(row.latestRevisionId),
              }),
        };
      },
    );
  }

  private async readRevision(
    connection: PoolConnection,
    boardId: BoardId,
    revisionBytes: Buffer,
  ): Promise<HistoryGetRow> {
    const [rows] = await connection.execute<HistoryGetRow[]>(
      `
      SELECT
        CAST(r.revision_pk AS CHAR) AS revisionPk,
        r.revision_id AS revisionId,
        CAST(r.revision_number AS CHAR) AS revisionNumber,
        r.created_at AS revisionCreatedAt,
        previous.revision_id AS previousRevisionId,
        source.revision_id AS sourceRevisionId,
        r.origin_code AS originCode,
        r.actor_kind AS actorKind,
        r.actor_principal_id AS actorPrincipalId,
        r.label,
        c.truncated_before AS truncatedBefore,
        oldest_revision.revision_id AS oldestRetainedRevisionId,
        CAST(c.actor_account_pk AS CHAR) AS actorAccountPk,
        c.actor_class AS actorClass,
        next_revision.revision_id AS nextRevisionId,
        latest.revision_id AS latestRevisionId,
        COALESCE(p.schema_version, r.scene_schema_version) AS sceneSchemaVersion,
        COALESCE(p.codec, r.scene_codec) AS sceneCodec,
        COALESCE(p.payload, r.scene_payload) AS scenePayload,
        COALESCE(p.canonical_bytes, r.scene_canonical_bytes) AS sceneCanonicalBytes,
        COALESCE(p.stored_bytes, r.scene_stored_bytes) AS sceneStoredBytes,
        COALESCE(p.payload_sha256, r.scene_sha256) AS sceneSha256,
        CAST(h.last_event_sequence AS CHAR) AS lastEventSequence
      FROM boards b
      JOIN board_heads h ON h.board_pk = b.board_pk
      JOIN board_revisions latest
        ON latest.board_pk = h.board_pk
          AND latest.revision_pk = h.head_revision_pk
          AND latest.revision_number = h.head_revision_number
      JOIN board_revision_catalog latest_catalog
        ON latest_catalog.board_pk = latest.board_pk
       AND latest_catalog.revision_pk = latest.revision_pk
      JOIN board_revision_catalog c ON c.board_pk = b.board_pk
      JOIN board_revisions r
        ON r.board_pk = c.board_pk AND r.revision_pk = c.revision_pk AND r.revision_id = ?
      LEFT JOIN board_revision_payloads p ON p.revision_pk = r.revision_pk AND p.state = 'available'
      JOIN board_revision_catalog oldest_catalog
        ON oldest_catalog.board_pk = c.board_pk
       AND oldest_catalog.retained_order = (
         SELECT MIN(oc.retained_order) FROM board_revision_catalog oc WHERE oc.board_pk = c.board_pk
       )
      JOIN board_revisions oldest_revision
        ON oldest_revision.board_pk = oldest_catalog.board_pk
       AND oldest_revision.revision_pk = oldest_catalog.revision_pk
      LEFT JOIN board_revision_catalog previous_catalog
        ON previous_catalog.board_pk = c.board_pk
       AND previous_catalog.retained_order = (
         SELECT MAX(pc.retained_order)
         FROM board_revision_catalog pc
         WHERE pc.board_pk = c.board_pk AND pc.retained_order < c.retained_order
       )
      LEFT JOIN board_revisions previous
        ON previous.board_pk = previous_catalog.board_pk
       AND previous.revision_pk = previous_catalog.revision_pk
      LEFT JOIN board_revisions source
        ON source.board_pk = r.board_pk AND source.revision_pk = r.source_revision_pk
      LEFT JOIN board_revision_catalog next_catalog
        ON next_catalog.board_pk = c.board_pk
       AND next_catalog.retained_order = (
         SELECT MIN(nc.retained_order)
         FROM board_revision_catalog nc
         WHERE nc.board_pk = c.board_pk AND nc.retained_order > c.retained_order
       )
      LEFT JOIN board_revisions next_revision
        ON next_revision.board_pk = next_catalog.board_pk
       AND next_revision.revision_pk = next_catalog.revision_pk
      WHERE b.public_id = ?
      LIMIT 1
    `,
      [revisionBytes, boardId],
    );
    const row = rows[0];
    if (rows.length === 0) throw notFound();
    if (rows.length !== 1 || row === undefined) throw new BoardPersistenceError('row_integrity');
    return row;
  }

  private async assertReferences(
    connection: PoolConnection,
    revisionPk: string,
    checkpoint: Awaited<ReturnType<DocumentCheckpointCodec['decode']>>,
  ): Promise<void> {
    const [rows] = await connection.execute<ReferenceRow[]>(
      `
      SELECT artifact_id AS artifactId, artifact_version_id AS artifactVersionId,
             reference_code AS referenceCode, occurrence_count AS occurrenceCount
      FROM board_revision_artifact_refs
      WHERE revision_pk = ?
      ORDER BY artifact_id, artifact_version_id, reference_code
    `,
      [revisionPk],
    );
    const stored = rows.map((row) => ({
      artifactId: row.artifactId,
      artifactVersionId: row.artifactVersionId,
      referenceCode: row.referenceCode,
      occurrenceCount: row.occurrenceCount,
    }));
    const expected =
      checkpoint.kind === 'scene'
        ? extractSceneArtifactReferences(checkpoint.scene)
        : extractDocumentArtifactReferences(checkpoint.document);
    if (JSON.stringify(stored) !== JSON.stringify(expected)) {
      throw new BoardPersistenceError('row_integrity');
    }
  }

  private async assertMediaReferences(
    connection: PoolConnection,
    revisionPk: string,
    boardId: BoardId,
    revisionId: RevisionId,
    checkpoint: Awaited<ReturnType<DocumentCheckpointCodec['decode']>>,
  ): Promise<void> {
    const [rows] = await connection.execute<MediaReferenceRow[]>(
      `
      SELECT media_id AS mediaId, first_page_id AS firstPageId, ordinal
      FROM board_revision_media_refs
      WHERE revision_pk = ?
      ORDER BY ordinal
    `,
      [revisionPk],
    );
    let stored: Array<{
      boardId: BoardId;
      revisionId: RevisionId;
      mediaId: string;
      firstPageId: string;
      ordinal: number;
    }>;
    try {
      stored = rows.map((row, index) => {
        if (row.ordinal !== index + 1) throw new BoardPersistenceError('row_integrity');
        return {
          boardId,
          revisionId,
          mediaId: decodeMediaIdFromStorage(row.mediaId),
          firstPageId: decodePageIdFromStorage(row.firstPageId),
          ordinal: row.ordinal,
        };
      });
    } catch (error) {
      if (error instanceof BoardPersistenceError) throw error;
      throw new BoardPersistenceError('row_integrity', error);
    }
    const document =
      checkpoint.kind === 'document'
        ? checkpoint.document
        : adaptLegacySceneToDocumentV2({ boardId, scene: checkpoint.scene });
    const expected = this.mediaReferences.extract({ boardId, revisionId, document });
    if (JSON.stringify(stored) !== JSON.stringify(expected)) {
      throw new BoardPersistenceError('row_integrity');
    }
  }
}
