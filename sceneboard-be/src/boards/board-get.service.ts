import {
  BoardIdParserV1,
  BoardOperationResultParserV1,
  BoardOperationResultParserV2,
  BoardOperationResultParserV3,
  PrincipalIdParserV1,
  adaptLegacySceneToDocumentV2,
  projectDocumentV2ToV3,
  projectDocumentV3ToV2,
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
import type { DatabaseOperationOwnershipV1 } from '../database/transaction.js';
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
  sceneSchemaVersion: string | null;
  sceneCodec: string | null;
  scenePayload: Buffer | null;
  sceneCanonicalBytes: number | null;
  sceneStoredBytes: number | null;
  sceneSha256: Buffer | null;
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

interface AuthorizedBoardHeadRow extends RowDataPacket {
  boardId: string;
  sceneSchemaVersion: string | null;
  lastEventSequence: string;
}

export type AuthorizedBoardHeadV1 = Readonly<{
  lastEventSequence: number;
  headSchemaVersion: 1 | 2 | 3;
}>;

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

const upgradeRequired = (requestedDocumentSchemaVersion: 1 | 2): BoardContractError =>
  new BoardContractError({
    protocolVersion: 1,
    type: 'board.error',
    code: 'UPGRADE_REQUIRED',
    message: 'A newer document client is required',
    category: 'conflict',
    retryable: false,
    httpStatusHint: 409,
    details: {
      headSchemaVersion: 3,
      requestedDocumentSchemaVersion,
      surface: 'board.get',
    },
  });

const legacyDocumentUnsupported = (): BoardContractError =>
  new BoardContractError({
    protocolVersion: 1,
    type: 'board.error',
    code: 'PROTOCOL_VERSION_MISMATCH',
    message: 'Document snapshots require a document-capable client',
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

const parsedHeadSchemaVersion = (value: string | null): 1 | 2 | 3 => {
  if (value === '1.0.0') return 1;
  if (value === '2.0.0') return 2;
  if (value === '3.0.0') return 3;
  throw new BoardPersistenceError('row_integrity');
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
    documentSchemaVersion?: 1 | 2 | 3;
  }): Promise<BoardOperationResultV1> {
    const ownership = (input as typeof input & { ownership?: DatabaseOperationOwnershipV1 })
      .ownership;
    return this.accessPolicy.withAuthorizedBoardTransaction(
      {
        principal: input.principal,
        operation: 'board.get',
        boardId: input.boardId,
        isolation: 'REPEATABLE_READ_CUT',
        ...(ownership === undefined ? {} : { ownership }),
      },
      async (connection, context) => {
        const row = await this.readHead(connection, input.boardId);
        const boardId = parsedBoardId(row.boardId);
        if (boardId !== input.boardId) throw new BoardPersistenceError('row_integrity');
        const revisionNumber = safePositive(row.revisionNumber);
        const lastEventSequence = safePositive(row.lastEventSequence);
        if (
          typeof row.sceneSchemaVersion !== 'string' ||
          typeof row.sceneCodec !== 'string' ||
          !Buffer.isBuffer(row.scenePayload) ||
          typeof row.sceneCanonicalBytes !== 'number' ||
          !Number.isSafeInteger(row.sceneCanonicalBytes) ||
          typeof row.sceneStoredBytes !== 'number' ||
          !Number.isSafeInteger(row.sceneStoredBytes) ||
          !Buffer.isBuffer(row.sceneSha256)
        ) {
          throw new BoardPersistenceError('row_integrity');
        }
        const checkpoint = await this.checkpoints.decode({
          schemaVersion: row.sceneSchemaVersion,
          codec: row.sceneCodec,
          payload: row.scenePayload,
          canonicalBytes: row.sceneCanonicalBytes,
          storedBytes: row.sceneStoredBytes,
          sha256: row.sceneSha256,
        });
        await this.assertReferences(connection, row.revisionPk, checkpoint);
        const requested = input.documentSchemaVersion;
        if (
          checkpoint.kind === 'document' &&
          checkpoint.document.schemaVersion === 3 &&
          (requested === undefined || requested === 1)
        ) {
          throw upgradeRequired(requested ?? 2);
        }
        if (
          checkpoint.kind === 'document' &&
          checkpoint.document.schemaVersion === 2 &&
          requested === 1
        ) {
          throw legacyDocumentUnsupported();
        }
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
        const composition = {
          actor: context.actor,
          boardId,
          revision,
          lastEventSequence,
        };
        const snapshot =
          requested === 3
            ? await this.snapshots.composeDocument(connection, {
                ...composition,
                checkpoint: {
                  kind: 'document',
                  document:
                    checkpoint.kind === 'scene'
                      ? projectDocumentV2ToV3(
                          adaptLegacySceneToDocumentV2({ boardId, scene: checkpoint.scene }),
                        )
                      : checkpoint.document.schemaVersion === 2
                        ? projectDocumentV2ToV3(checkpoint.document)
                        : checkpoint.document,
                  canonicalBytes: checkpoint.canonicalBytes,
                },
              })
            : requested === 2 ||
                (requested === undefined &&
                  checkpoint.kind === 'document' &&
                  checkpoint.document.schemaVersion === 2)
              ? await this.snapshots.composeDocument(connection, {
                  ...composition,
                  checkpoint: {
                    kind: 'document',
                    document:
                      checkpoint.kind === 'scene'
                        ? adaptLegacySceneToDocumentV2({ boardId, scene: checkpoint.scene })
                        : checkpoint.document.schemaVersion === 3
                          ? projectDocumentV3ToV2(checkpoint.document)
                          : checkpoint.document,
                    canonicalBytes: checkpoint.canonicalBytes,
                  },
                })
              : checkpoint.kind === 'scene'
                ? await this.snapshots.compose(connection, {
                    ...composition,
                    checkpoint,
                  })
                : (() => {
                    throw new BoardPersistenceError('row_integrity');
                  })();
        const parser =
          'document' in snapshot
            ? snapshot.document.schemaVersion === 3
              ? BoardOperationResultParserV3
              : BoardOperationResultParserV2
            : BoardOperationResultParserV1;
        const parsed = parser.parse({
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

  async getAuthorizedHead(input: {
    principal: ResolvedBoardPrincipalV1;
    boardId: BoardId;
    ownership?: DatabaseOperationOwnershipV1;
  }): Promise<AuthorizedBoardHeadV1> {
    return this.accessPolicy.withAuthorizedBoardTransaction(
      {
        principal: input.principal,
        operation: 'board.get',
        boardId: input.boardId,
        isolation: 'REPEATABLE_READ_CUT',
        ...(input.ownership === undefined ? {} : { ownership: input.ownership }),
      },
      async (connection) => {
        const [rows] = await connection.execute<AuthorizedBoardHeadRow[]>(
          `
          SELECT
            b.public_id AS boardId,
            CASE WHEN p.revision_pk IS NOT NULL
              THEN p.schema_version ELSE r.scene_schema_version END AS sceneSchemaVersion,
            CAST(h.last_event_sequence AS CHAR) AS lastEventSequence
          FROM boards b
          JOIN board_heads h ON h.board_pk = b.board_pk
          JOIN board_revisions r
            ON r.board_pk = h.board_pk AND r.revision_pk = h.head_revision_pk
              AND r.revision_number = h.head_revision_number
          LEFT JOIN board_revision_payloads p
            ON p.revision_pk = r.revision_pk AND p.state = 'available'
          WHERE b.public_id = ?
          LIMIT 1
        `,
          [input.boardId],
        );
        const row = rows[0];
        if (rows.length === 0) throw boardNotFound();
        if (rows.length !== 1 || row === undefined)
          throw new BoardPersistenceError('row_integrity');
        if (parsedBoardId(row.boardId) !== input.boardId)
          throw new BoardPersistenceError('row_integrity');
        return {
          lastEventSequence: safePositive(row.lastEventSequence),
          headSchemaVersion: parsedHeadSchemaVersion(row.sceneSchemaVersion),
        };
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
        CASE WHEN p.revision_pk IS NOT NULL
          THEN p.schema_version ELSE r.scene_schema_version END AS sceneSchemaVersion,
        CASE WHEN p.revision_pk IS NOT NULL
          THEN p.codec ELSE r.scene_codec END AS sceneCodec,
        CASE WHEN p.revision_pk IS NOT NULL
          THEN p.payload ELSE r.scene_payload END AS scenePayload,
        CASE WHEN p.revision_pk IS NOT NULL
          THEN p.canonical_bytes ELSE r.scene_canonical_bytes END AS sceneCanonicalBytes,
        CASE WHEN p.revision_pk IS NOT NULL
          THEN p.stored_bytes ELSE r.scene_stored_bytes END AS sceneStoredBytes,
        CASE WHEN p.revision_pk IS NOT NULL
          THEN p.payload_sha256 ELSE r.scene_sha256 END AS sceneSha256,
        r.actor_kind AS actorKind,
        r.actor_principal_id AS actorPrincipalId,
        r.created_at AS revisionCreatedAt,
        CAST(h.last_event_sequence AS CHAR) AS lastEventSequence
      FROM boards b
      JOIN board_heads h ON h.board_pk = b.board_pk
      JOIN board_revisions r
        ON r.board_pk = h.board_pk AND r.revision_pk = h.head_revision_pk
          AND r.revision_number = h.head_revision_number
      LEFT JOIN board_revision_payloads p
        ON p.revision_pk = r.revision_pk AND p.state = 'available'
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
