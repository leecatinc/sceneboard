import {
  BoardOperationResultParserV1,
  PrincipalIdParserV1,
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
import { DocumentCheckpointCodec } from '../revisions/document-checkpoint.codec.js';
import {
  extractDocumentArtifactReferences,
  extractSceneArtifactReferences,
} from '../revisions/scene-artifact-reference.extractor.js';
import { SnapshotCompositionService } from '../revisions/snapshot-composition.service.js';
import { historyGetMetadata, type HistoryAdapterMetadataV1 } from './history-adapter-metadata.js';

export type HistoryGetRequestV1 = BoardOperationRequestV1 & {
  protocolVersion: 1;
  requestId: RequestId;
  type: 'history.get';
  boardId: BoardId;
  revisionId: RevisionId;
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
}

interface ReferenceRow extends RowDataPacket {
  artifactId: string;
  artifactVersionId: string;
  referenceCode: string;
  occurrenceCount: number;
}

const notFound = (revisionId: RevisionId): BoardContractError =>
  new BoardContractError({
    protocolVersion: 1,
    type: 'board.error',
    code: 'REVISION_NOT_FOUND',
    message: 'Revision not found',
    category: 'not_found',
    retryable: false,
    httpStatusHint: 404,
    details: { revisionId },
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
  }): Promise<{ result: BoardOperationResultV1; metadata: HistoryAdapterMetadataV1 }> {
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
          throw notFound(input.request.revisionId);
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
        await this.assertReferences(connection, row.revisionPk, decoded);
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
        const snapshot =
          decoded.kind === 'scene'
            ? await this.snapshots.compose(connection, {
                actor: context.actor,
                boardId: input.request.boardId,
                revision,
                checkpoint: decoded,
                lastEventSequence,
              })
            : await this.snapshots.composeDocument(connection, {
                actor: context.actor,
                boardId: input.request.boardId,
                revision,
                checkpoint: decoded,
                lastEventSequence,
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
        const parsed = BoardOperationResultParserV1.parse({
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
          metadata: historyGetMetadata({
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
        next_revision.revision_id AS nextRevisionId,
        latest.revision_id AS latestRevisionId,
        r.scene_schema_version AS sceneSchemaVersion,
        r.scene_codec AS sceneCodec,
        r.scene_payload AS scenePayload,
        r.scene_canonical_bytes AS sceneCanonicalBytes,
        r.scene_stored_bytes AS sceneStoredBytes,
        r.scene_sha256 AS sceneSha256,
        CAST(h.last_event_sequence AS CHAR) AS lastEventSequence
      FROM boards b
      JOIN board_heads h ON h.board_pk = b.board_pk
      JOIN board_revisions latest
        ON latest.board_pk = h.board_pk
          AND latest.revision_pk = h.head_revision_pk
          AND latest.revision_number = h.head_revision_number
      JOIN board_revisions r ON r.board_pk = b.board_pk AND r.revision_id = ?
      LEFT JOIN board_revisions previous
        ON previous.board_pk = r.board_pk AND previous.revision_pk = r.previous_revision_pk
      LEFT JOIN board_revisions source
        ON source.board_pk = r.board_pk AND source.revision_pk = r.source_revision_pk
      LEFT JOIN board_revisions next_revision
        ON next_revision.board_pk = r.board_pk
          AND next_revision.revision_number = r.revision_number + 1
          AND next_revision.revision_number <= h.head_revision_number
      WHERE b.public_id = ?
      LIMIT 1
    `,
      [revisionBytes, boardId],
    );
    const row = rows[0];
    if (rows.length === 0) throw notFound(formatPublicUuidV4(revisionBytes) as RevisionId);
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
}
