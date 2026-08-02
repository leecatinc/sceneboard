import {
  adaptLegacySceneToDocumentV2,
  GlobalIdStringParserV1,
  MAX_ARTIFACT_REFERENCE_OCCURRENCES,
  MAX_MEDIA_REFERENCES,
  projectDocumentV2ToV3,
  type BoardId,
  type RevisionId,
} from '@sceneboard/board-schema';
import type { PoolConnection, ResultSetHeader } from 'mysql2/promise';

import { BoardPersistenceError } from '../common/errors/board-persistence.error.js';
import {
  internalFailure,
  referenceRowsEqual,
  revisionIdFromBytes,
  revisionNotFound,
  safePositive,
  uuidBytesOrNull,
} from './board-mutation.support.js';
import type {
  RestorePreparedV1,
  CheckpointMutationRequest,
  RestoreSourceRow,
  StoredMediaReferenceRow,
  StoredReferenceRow,
} from './board-mutation.types.js';
import {
  decodeMediaIdFromStorage,
  decodePageIdFromStorage,
  encodeMediaIdForStorage,
  encodePageIdForStorage,
  type RevisionMediaReferenceRowV1,
} from '../media/media-reference.types.js';
import { RevisionMediaReferenceExtractor } from '../media/revision-media-reference.extractor.js';
import {
  extractDocumentArtifactReferences,
  extractSceneArtifactReferences,
  type SceneArtifactReferenceRowV1,
} from './scene-artifact-reference.extractor.js';
import {
  DocumentCheckpointCodec,
  type EncodedBoardCheckpoint,
} from './document-checkpoint.codec.js';

const mediaReferenceRowsEqual = (
  left: readonly RevisionMediaReferenceRowV1[],
  right: readonly RevisionMediaReferenceRowV1[],
): boolean =>
  left.length === right.length &&
  left.every((reference, index) => {
    const expected = right[index];
    return (
      expected !== undefined &&
      reference.boardId === expected.boardId &&
      reference.revisionId === expected.revisionId &&
      reference.firstPageId === expected.firstPageId &&
      reference.mediaId === expected.mediaId &&
      reference.ordinal === expected.ordinal
    );
  });

export class BoardMutationRestoreRepository {
  constructor(
    private readonly checkpoints: DocumentCheckpointCodec,
    private readonly mediaReferences = new RevisionMediaReferenceExtractor(),
  ) {}

  async prepareRestore(
    connection: PoolConnection,
    request: CheckpointMutationRequest,
  ): Promise<RestorePreparedV1> {
    if (request.command.type !== 'scene.restore') throw internalFailure();
    const sourceBytes = uuidBytesOrNull(request.command.sourceRevisionId);
    if (sourceBytes === null) throw revisionNotFound(request.command.sourceRevisionId);
    const [rows] = await connection.execute<RestoreSourceRow[]>(
      `
      SELECT
        CAST(r.revision_pk AS CHAR) AS revisionPk,
        r.revision_id AS revisionId,
        CAST(r.revision_number AS CHAR) AS revisionNumber,
        COALESCE(p.schema_version, r.scene_schema_version) AS sceneSchemaVersion,
        COALESCE(p.codec, r.scene_codec) AS sceneCodec,
        COALESCE(p.payload, r.scene_payload) AS scenePayload,
        COALESCE(p.canonical_bytes, r.scene_canonical_bytes) AS sceneCanonicalBytes,
        COALESCE(p.stored_bytes, r.scene_stored_bytes) AS sceneStoredBytes,
        COALESCE(p.payload_sha256, r.scene_sha256) AS sceneSha256
      FROM boards b
      JOIN board_revision_catalog c ON c.board_pk = b.board_pk
      JOIN board_revisions r ON r.board_pk = c.board_pk AND r.revision_pk = c.revision_pk
      LEFT JOIN board_revision_payloads p ON p.revision_pk = r.revision_pk AND p.state = 'available'
      WHERE b.public_id = ? AND r.revision_id = ?
      LIMIT 1
    `,
      [request.boardId, sourceBytes],
    );
    const row = rows[0];
    if (rows.length === 0) throw revisionNotFound(request.command.sourceRevisionId);
    if (
      rows.length !== 1 ||
      row === undefined ||
      revisionIdFromBytes(row.revisionId) !== request.command.sourceRevisionId
    ) {
      throw internalFailure();
    }
    safePositive(row.revisionNumber);
    const decoded = await this.checkpoints.decode({
      schemaVersion: row.sceneSchemaVersion,
      codec: row.sceneCodec,
      payload: row.scenePayload,
      canonicalBytes: row.sceneCanonicalBytes,
      storedBytes: row.sceneStoredBytes,
      sha256: row.sceneSha256,
    });
    const references = await this.readReferences(connection, row.revisionPk);
    const mediaReferences = await this.readMediaReferences(
      connection,
      row.revisionPk,
      request.boardId,
      request.command.sourceRevisionId,
    );
    const document =
      decoded.kind === 'document'
        ? decoded.document
        : adaptLegacySceneToDocumentV2({ boardId: request.boardId, scene: decoded.scene });
    const expectedReferences =
      decoded.kind === 'scene'
        ? extractSceneArtifactReferences(decoded.scene)
        : extractDocumentArtifactReferences(decoded.document);
    const expectedMediaReferences = this.mediaReferences.extract({
      boardId: request.boardId,
      revisionId: request.command.sourceRevisionId,
      document,
    });
    if (
      !referenceRowsEqual(references, expectedReferences) ||
      !mediaReferenceRowsEqual(mediaReferences, expectedMediaReferences)
    ) {
      throw new BoardPersistenceError('row_integrity');
    }
    return {
      row,
      checkpoint: {
        schemaVersion:
          row.sceneSchemaVersion === '1.0.0' ||
          row.sceneSchemaVersion === '2.0.0' ||
          row.sceneSchemaVersion === '3.0.0'
            ? row.sceneSchemaVersion
            : (() => {
                throw new BoardPersistenceError('row_integrity');
              })(),
        codec: 'B',
        payload: Buffer.from(row.scenePayload),
        canonicalPayload: Buffer.from(decoded.canonicalBytes),
        canonicalBytes: row.sceneCanonicalBytes,
        storedBytes: row.sceneStoredBytes,
        sha256: Buffer.from(row.sceneSha256),
      },
      decoded,
      references,
      mediaReferences,
    };
  }

  async revalidateRestore(
    connection: PoolConnection,
    boardPk: string,
    prepared: RestorePreparedV1,
    headSchemaVersion: string,
    boardId: BoardId,
    targetRevisionId: RevisionId,
    documentSchemaVersion: 1 | 2 | 3,
  ): Promise<{
    checkpoint: EncodedBoardCheckpoint;
    references: readonly SceneArtifactReferenceRowV1[];
    mediaReferences: readonly RevisionMediaReferenceRowV1[];
    sourceRevisionPk: string;
  }> {
    const [rows] = await connection.execute<RestoreSourceRow[]>(
      `
      SELECT
        CAST(r.revision_pk AS CHAR) AS revisionPk,
        r.revision_id AS revisionId,
        CAST(r.revision_number AS CHAR) AS revisionNumber,
        COALESCE(p.schema_version, r.scene_schema_version) AS sceneSchemaVersion,
        COALESCE(p.codec, r.scene_codec) AS sceneCodec,
        COALESCE(p.payload, r.scene_payload) AS scenePayload,
        COALESCE(p.canonical_bytes, r.scene_canonical_bytes) AS sceneCanonicalBytes,
        COALESCE(p.stored_bytes, r.scene_stored_bytes) AS sceneStoredBytes,
        COALESCE(p.payload_sha256, r.scene_sha256) AS sceneSha256
      FROM board_revision_catalog c
      JOIN board_revisions r ON r.board_pk = c.board_pk AND r.revision_pk = c.revision_pk
      LEFT JOIN board_revision_payloads p ON p.revision_pk = r.revision_pk AND p.state = 'available'
      WHERE r.board_pk = ? AND r.revision_pk = ?
      LIMIT 1
    `,
      [boardPk, prepared.row.revisionPk],
    );
    const row = rows[0];
    if (
      rows.length !== 1 ||
      row === undefined ||
      row.revisionPk !== prepared.row.revisionPk ||
      !row.revisionId.equals(prepared.row.revisionId) ||
      row.revisionNumber !== prepared.row.revisionNumber ||
      row.sceneSchemaVersion !== prepared.row.sceneSchemaVersion ||
      row.sceneCodec !== prepared.row.sceneCodec ||
      row.sceneCanonicalBytes !== prepared.row.sceneCanonicalBytes ||
      row.sceneStoredBytes !== prepared.row.sceneStoredBytes ||
      !row.sceneSha256.equals(prepared.row.sceneSha256) ||
      !row.scenePayload.equals(prepared.row.scenePayload)
    ) {
      throw new BoardPersistenceError('row_integrity');
    }
    const references = await this.readReferences(connection, row.revisionPk);
    const sourceRevisionId = revisionIdFromBytes(row.revisionId) as RevisionId;
    const mediaReferences = await this.readMediaReferences(
      connection,
      row.revisionPk,
      boardId,
      sourceRevisionId,
    );
    if (
      !referenceRowsEqual(references, prepared.references) ||
      !mediaReferenceRowsEqual(mediaReferences, prepared.mediaReferences)
    ) {
      throw new BoardPersistenceError('row_integrity');
    }
    if (
      headSchemaVersion !== '1.0.0' &&
      headSchemaVersion !== '2.0.0' &&
      headSchemaVersion !== '3.0.0'
    )
      throw new BoardPersistenceError('row_integrity');
    if (documentSchemaVersion === 3) {
      const document =
        prepared.decoded.kind === 'scene'
          ? projectDocumentV2ToV3(
              adaptLegacySceneToDocumentV2({
                boardId,
                scene: prepared.decoded.scene,
              }),
            )
          : prepared.decoded.document.schemaVersion === 2
            ? projectDocumentV2ToV3(prepared.decoded.document)
            : prepared.decoded.document;
      return {
        checkpoint: await this.checkpoints.encodeDocumentV3(document),
        references: extractDocumentArtifactReferences(document),
        mediaReferences: this.mediaReferences.extract({
          boardId,
          revisionId: targetRevisionId,
          document,
        }),
        sourceRevisionPk: row.revisionPk,
      };
    }
    if (prepared.decoded.kind === 'document' && prepared.decoded.document.schemaVersion === 3)
      throw new BoardPersistenceError('row_integrity');
    if (prepared.decoded.kind === 'scene' && headSchemaVersion === '2.0.0') {
      const document = adaptLegacySceneToDocumentV2({
        boardId,
        scene: prepared.decoded.scene,
      });
      return {
        checkpoint: await this.checkpoints.encodeDocument(document),
        references: extractDocumentArtifactReferences(document),
        mediaReferences: this.mediaReferences.extract({
          boardId,
          revisionId: targetRevisionId,
          document,
        }),
        sourceRevisionPk: row.revisionPk,
      };
    }
    return {
      checkpoint: prepared.checkpoint,
      references,
      mediaReferences: mediaReferences.map((reference) => ({
        ...reference,
        revisionId: targetRevisionId,
      })),
      sourceRevisionPk: row.revisionPk,
    };
  }

  async insertReferences(
    connection: PoolConnection,
    revisionPk: bigint,
    references: readonly SceneArtifactReferenceRowV1[],
  ): Promise<void> {
    if (references.length === 0) return;
    const placeholders = references.map(() => '(?, ?, ?, ?, ?)').join(', ');
    const binds = references.flatMap((reference) => [
      revisionPk.toString(),
      reference.artifactId,
      reference.artifactVersionId,
      reference.referenceCode,
      reference.occurrenceCount,
    ]);
    const [insert] = await connection.execute<ResultSetHeader>(
      `
      INSERT INTO board_revision_artifact_refs (
        revision_pk, artifact_id, artifact_version_id, reference_code, occurrence_count
      ) VALUES ${placeholders}
    `,
      binds,
    );
    if (insert.affectedRows !== references.length) throw internalFailure();
  }

  async insertMediaReferences(
    connection: PoolConnection,
    input: {
      boardPk: bigint;
      revisionPk: bigint;
      references: readonly RevisionMediaReferenceRowV1[];
    },
  ): Promise<void> {
    if (input.references.length === 0) return;
    if (
      input.references.length > MAX_MEDIA_REFERENCES ||
      new Set(input.references.map((reference) => reference.mediaId)).size !==
        input.references.length ||
      input.references.some((reference, index) => reference.ordinal !== index + 1)
    ) {
      throw internalFailure();
    }
    const placeholders = input.references.map(() => '(?, ?, ?, ?, ?)').join(', ');
    const binds = input.references.flatMap((reference) => [
      input.boardPk.toString(),
      input.revisionPk.toString(),
      encodeMediaIdForStorage(reference.mediaId),
      encodePageIdForStorage(reference.firstPageId),
      reference.ordinal,
    ]);
    const [insert] = await connection.execute<ResultSetHeader>(
      `
      INSERT INTO board_revision_media_refs (
        board_pk, revision_pk, media_id, first_page_id, ordinal
      ) VALUES ${placeholders}
    `,
      binds,
    );
    if (insert.affectedRows !== input.references.length) throw internalFailure();
  }

  async assertReplayRevisionIntegrity(
    connection: PoolConnection,
    boardId: BoardId,
    revisionId: RevisionId,
  ): Promise<{
    boardPk: bigint;
    mediaReferences: readonly RevisionMediaReferenceRowV1[];
  }> {
    const revisionBytes = uuidBytesOrNull(revisionId);
    if (revisionBytes === null) throw new BoardPersistenceError('row_integrity');
    const [rows] = await connection.execute<(RestoreSourceRow & { boardPk: string })[]>(
      `
      SELECT
        CAST(r.board_pk AS CHAR) AS boardPk,
        CAST(r.revision_pk AS CHAR) AS revisionPk,
        r.revision_id AS revisionId,
        CAST(r.revision_number AS CHAR) AS revisionNumber,
        COALESCE(p.schema_version, r.scene_schema_version) AS sceneSchemaVersion,
        COALESCE(p.codec, r.scene_codec) AS sceneCodec,
        COALESCE(p.payload, r.scene_payload) AS scenePayload,
        COALESCE(p.canonical_bytes, r.scene_canonical_bytes) AS sceneCanonicalBytes,
        COALESCE(p.stored_bytes, r.scene_stored_bytes) AS sceneStoredBytes,
        COALESCE(p.payload_sha256, r.scene_sha256) AS sceneSha256
      FROM boards b
      JOIN board_revision_catalog c ON c.board_pk = b.board_pk
      JOIN board_revisions r ON r.board_pk = c.board_pk AND r.revision_pk = c.revision_pk
      LEFT JOIN board_revision_payloads p ON p.revision_pk = r.revision_pk AND p.state = 'available'
      WHERE b.public_id = ? AND r.revision_id = ?
      LIMIT 1
    `,
      [boardId, revisionBytes],
    );
    const row = rows[0];
    if (
      rows.length !== 1 ||
      row === undefined ||
      revisionIdFromBytes(row.revisionId) !== revisionId
    ) {
      throw new BoardPersistenceError('row_integrity');
    }
    const decoded = await this.checkpoints.decode({
      schemaVersion: row.sceneSchemaVersion,
      codec: row.sceneCodec,
      payload: row.scenePayload,
      canonicalBytes: row.sceneCanonicalBytes,
      storedBytes: row.sceneStoredBytes,
      sha256: row.sceneSha256,
    });
    const document =
      decoded.kind === 'document'
        ? decoded.document
        : adaptLegacySceneToDocumentV2({ boardId, scene: decoded.scene });
    const storedReferences = await this.readReferences(connection, row.revisionPk);
    const expectedReferences =
      decoded.kind === 'scene'
        ? extractSceneArtifactReferences(decoded.scene)
        : extractDocumentArtifactReferences(decoded.document);
    const storedMediaReferences = await this.readMediaReferences(
      connection,
      row.revisionPk,
      boardId,
      revisionId,
    );
    const expectedMediaReferences = this.mediaReferences.extract({ boardId, revisionId, document });
    if (
      !referenceRowsEqual(storedReferences, expectedReferences) ||
      !mediaReferenceRowsEqual(storedMediaReferences, expectedMediaReferences)
    ) {
      throw new BoardPersistenceError('row_integrity');
    }
    return { boardPk: BigInt(row.boardPk), mediaReferences: storedMediaReferences };
  }

  private async readReferences(
    connection: PoolConnection,
    revisionPk: string,
  ): Promise<SceneArtifactReferenceRowV1[]> {
    const [rows] = await connection.execute<StoredReferenceRow[]>(
      `
      SELECT artifact_id AS artifactId, artifact_version_id AS artifactVersionId,
             reference_code AS referenceCode, occurrence_count AS occurrenceCount
      FROM board_revision_artifact_refs
      WHERE revision_pk = ?
      ORDER BY artifact_id, artifact_version_id, reference_code
    `,
      [revisionPk],
    );
    return rows.map((row) => {
      if (
        !GlobalIdStringParserV1.parse(row.artifactId).ok ||
        !GlobalIdStringParserV1.parse(row.artifactVersionId).ok ||
        (row.referenceCode !== 'A' && row.referenceCode !== 'I') ||
        !Number.isSafeInteger(row.occurrenceCount) ||
        row.occurrenceCount < 1 ||
        row.occurrenceCount > MAX_ARTIFACT_REFERENCE_OCCURRENCES
      ) {
        throw new BoardPersistenceError('row_integrity');
      }
      return {
        artifactId: row.artifactId,
        artifactVersionId: row.artifactVersionId,
        referenceCode: row.referenceCode,
        occurrenceCount: row.occurrenceCount,
      };
    });
  }

  private async readMediaReferences(
    connection: PoolConnection,
    revisionPk: string,
    boardId: BoardId,
    revisionId: RevisionId,
  ): Promise<RevisionMediaReferenceRowV1[]> {
    const [rows] = await connection.execute<StoredMediaReferenceRow[]>(
      `
      SELECT media_id AS mediaId, first_page_id AS firstPageId, ordinal
      FROM board_revision_media_refs
      WHERE revision_pk = ?
      ORDER BY ordinal
    `,
      [revisionPk],
    );
    return rows.map((row, index) => {
      if (row.ordinal !== index + 1) throw new BoardPersistenceError('row_integrity');
      try {
        return {
          boardId,
          revisionId,
          mediaId: decodeMediaIdFromStorage(row.mediaId),
          firstPageId: decodePageIdFromStorage(row.firstPageId),
          ordinal: row.ordinal,
        };
      } catch (error) {
        throw new BoardPersistenceError('row_integrity', error);
      }
    });
  }
}
