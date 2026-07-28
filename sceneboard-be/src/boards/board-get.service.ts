import {
  BoardIdParserV1,
  BoardOperationResultParserV1,
  PrincipalIdParserV1,
  type BoardId,
  type BoardOperationResultV1,
  type PrincipalId,
  type RequestId,
  type RevisionId,
  type RevisionOriginTypeV1,
  type TimestampV1,
} from '@sceneboard/board-schema';
import type { PoolConnection, RowDataPacket } from 'mysql2/promise';

import { BoardContractError } from '../common/errors/app-error.js';
import { BoardPersistenceError } from '../common/errors/board-persistence.error.js';
import { formatPublicUuidV4 } from '../common/ids/public-uuid.storage.js';
import { parseMysqlTimestampUtc } from '../common/time/mysql-timestamp.js';
import type { BoardAccessPolicy, ResolvedBoardPrincipalV1 } from '../grants/board-access.policy.js';
import { DocumentCheckpointCodec } from '../revisions/document-checkpoint.codec.js';
import {
  extractDocumentArtifactReferences,
  extractSceneArtifactReferences,
} from '../revisions/scene-artifact-reference.extractor.js';
import { SnapshotCompositionService } from '../revisions/snapshot-composition.service.js';

interface BoardHeadRow extends RowDataPacket {
  boardPk: string;
  boardId: string;
  title: string;
  boardCreatedAt: string;
  boardUpdatedAt: string;
  archivedAt: string | null;
  revisionPk: string;
  revisionId: Buffer;
  revisionNumber: string;
  previousRevisionId: Buffer | null;
  sourceRevisionId: Buffer | null;
  originCode: string;
  sceneSchemaVersion: string;
  sceneCodec: string;
  scenePayload: Buffer;
  sceneCanonicalBytes: number;
  sceneStoredBytes: number;
  sceneSha256: Buffer;
  actorKind: string;
  actorPrincipalId: string;
  revisionCreatedAt: string;
  lastEventSequence: string;
}

interface RevisionArtifactRefRow extends RowDataPacket {
  artifactId: string;
  artifactVersionId: string;
  referenceCode: string;
  occurrenceCount: number;
}

const boardNotFound = (): BoardContractError =>
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

const safePositive = (value: string): number => {
  if (!/^[1-9][0-9]{0,15}$/.test(value)) throw new BoardPersistenceError('row_integrity');
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new BoardPersistenceError('row_integrity');
  return parsed;
};

const timestamp = (value: string): TimestampV1 =>
  parseMysqlTimestampUtc(value).toISOString() as TimestampV1;

const actorKind = (value: string): 'user' | 'mcp_client' | 'service' => {
  if (value === 'U') return 'user';
  if (value === 'M') return 'mcp_client';
  if (value === 'S') return 'service';
  throw new BoardPersistenceError('row_integrity');
};

const originType = (value: string): RevisionOriginTypeV1 => {
  if (value === 'C') return 'board.create';
  if (value === 'R') return 'scene.replace';
  if (value === 'L') return 'scene.clear';
  if (value === 'S') return 'scene.restore';
  if (value === 'D') return 'document.replace';
  throw new BoardPersistenceError('row_integrity');
};

const parsedBoardId = (value: string): BoardId => {
  const result = BoardIdParserV1.parse(value);
  if (!result.ok) throw new BoardPersistenceError('row_integrity');
  return result.data.value;
};

const parsedRevisionId = (value: Uint8Array): RevisionId => {
  return formatPublicUuidV4(value) as RevisionId;
};

const parsedPrincipalId = (value: string): PrincipalId => {
  const result = PrincipalIdParserV1.parse(value);
  if (!result.ok) throw new BoardPersistenceError('row_integrity');
  return result.data.value;
};

export class BoardGetService {
  constructor(
    private readonly accessPolicy: BoardAccessPolicy,
    private readonly checkpoints: DocumentCheckpointCodec,
    private readonly snapshots: SnapshotCompositionService,
  ) {}

  async get(input: {
    principal: ResolvedBoardPrincipalV1;
    requestId: RequestId;
    boardId: BoardId;
  }): Promise<BoardOperationResultV1> {
    return this.accessPolicy.withAuthorizedBoardTransaction(
      {
        principal: input.principal,
        operation: 'board.get',
        boardId: input.boardId,
        isolation: 'REPEATABLE_READ_CUT',
      },
      async (connection, context) => {
        const row = await this.readHead(connection, input.boardId);
        const boardId = parsedBoardId(row.boardId);
        if (boardId !== input.boardId) throw new BoardPersistenceError('row_integrity');
        const revisionNumber = safePositive(row.revisionNumber);
        const lastEventSequence = safePositive(row.lastEventSequence);
        const checkpoint = await this.checkpoints.decode({
          schemaVersion: row.sceneSchemaVersion,
          codec: row.sceneCodec,
          payload: row.scenePayload,
          canonicalBytes: row.sceneCanonicalBytes,
          storedBytes: row.sceneStoredBytes,
          sha256: row.sceneSha256,
        });
        await this.assertReferences(connection, row.revisionPk, checkpoint);
        const revision = {
          revisionId: parsedRevisionId(row.revisionId),
          revisionNumber,
          createdAt: timestamp(row.revisionCreatedAt),
          previousRevisionId:
            row.previousRevisionId === null ? null : parsedRevisionId(row.previousRevisionId),
          originType: originType(row.originCode),
          sourceRevisionId:
            row.sourceRevisionId === null ? null : parsedRevisionId(row.sourceRevisionId),
          actor: {
            principalKind: actorKind(row.actorKind),
            principalId: parsedPrincipalId(row.actorPrincipalId),
          },
        } as const;
        const snapshot =
          checkpoint.kind === 'scene'
            ? await this.snapshots.compose(connection, {
                actor: context.actor,
                boardId,
                revision,
                checkpoint,
                lastEventSequence,
              })
            : await this.snapshots.composeDocument(connection, {
                actor: context.actor,
                boardId,
                revision,
                checkpoint,
                lastEventSequence,
              });
        const parsed = BoardOperationResultParserV1.parse({
          protocolVersion: 1,
          type: 'board.operation.result',
          requestId: input.requestId,
          replayed: false,
          result: {
            type: 'board.get',
            board: {
              boardId,
              title: row.title,
              createdAt: timestamp(row.boardCreatedAt),
              updatedAt: timestamp(row.boardUpdatedAt),
              archivedAt: row.archivedAt === null ? null : timestamp(row.archivedAt),
              headRevision: {
                revisionId: revision.revisionId,
                revisionNumber,
                createdAt: revision.createdAt,
              },
            },
            snapshot,
          },
        });
        if (!parsed.ok) throw new BoardPersistenceError('row_integrity');
        return parsed.data.value;
      },
    );
  }

  private async readHead(connection: PoolConnection, boardId: BoardId): Promise<BoardHeadRow> {
    const [rows] = await connection.execute<BoardHeadRow[]>(
      `
      SELECT
        CAST(b.board_pk AS CHAR) AS boardPk,
        b.public_id AS boardId,
        b.title,
        b.created_at AS boardCreatedAt,
        b.updated_at AS boardUpdatedAt,
        b.archived_at AS archivedAt,
        CAST(r.revision_pk AS CHAR) AS revisionPk,
        r.revision_id AS revisionId,
        CAST(r.revision_number AS CHAR) AS revisionNumber,
        previous.revision_id AS previousRevisionId,
        source.revision_id AS sourceRevisionId,
        r.origin_code AS originCode,
        r.scene_schema_version AS sceneSchemaVersion,
        r.scene_codec AS sceneCodec,
        r.scene_payload AS scenePayload,
        r.scene_canonical_bytes AS sceneCanonicalBytes,
        r.scene_stored_bytes AS sceneStoredBytes,
        r.scene_sha256 AS sceneSha256,
        r.actor_kind AS actorKind,
        r.actor_principal_id AS actorPrincipalId,
        r.created_at AS revisionCreatedAt,
        CAST(h.last_event_sequence AS CHAR) AS lastEventSequence
      FROM boards b
      JOIN board_heads h ON h.board_pk = b.board_pk
      JOIN board_revisions r
        ON r.board_pk = h.board_pk AND r.revision_pk = h.head_revision_pk
          AND r.revision_number = h.head_revision_number
      LEFT JOIN board_revisions previous
        ON previous.board_pk = r.board_pk AND previous.revision_pk = r.previous_revision_pk
      LEFT JOIN board_revisions source
        ON source.board_pk = r.board_pk AND source.revision_pk = r.source_revision_pk
      WHERE b.public_id = ?
      LIMIT 1
    `,
      [boardId],
    );
    const row = rows[0];
    if (rows.length === 0) throw boardNotFound();
    if (rows.length !== 1 || row === undefined) throw new BoardPersistenceError('row_integrity');
    return row;
  }

  private async assertReferences(
    connection: PoolConnection,
    revisionPk: string,
    checkpoint: Awaited<ReturnType<DocumentCheckpointCodec['decode']>>,
  ): Promise<void> {
    const [rows] = await connection.execute<RevisionArtifactRefRow[]>(
      `
      SELECT
        artifact_id AS artifactId,
        artifact_version_id AS artifactVersionId,
        reference_code AS referenceCode,
        occurrence_count AS occurrenceCount
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
