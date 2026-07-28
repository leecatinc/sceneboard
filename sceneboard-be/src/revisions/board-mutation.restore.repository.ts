import {
  adaptLegacySceneToDocumentV2,
  type BoardId,
  type MutationRequestV2,
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
  RestoreSourceRow,
  StoredReferenceRow,
} from './board-mutation.types.js';
import {
  extractDocumentArtifactReferences,
  extractSceneArtifactReferences,
  type SceneArtifactReferenceRowV1,
} from './scene-artifact-reference.extractor.js';
import {
  DocumentCheckpointCodec,
  type EncodedBoardCheckpoint,
} from './document-checkpoint.codec.js';

export class BoardMutationRestoreRepository {
  constructor(private readonly checkpoints: DocumentCheckpointCodec) {}

  async prepareRestore(
    connection: PoolConnection,
    request: MutationRequestV2,
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
    const expectedReferences =
      decoded.kind === 'scene'
        ? extractSceneArtifactReferences(decoded.scene)
        : extractDocumentArtifactReferences(decoded.document);
    if (!referenceRowsEqual(references, expectedReferences)) {
      throw new BoardPersistenceError('row_integrity');
    }
    return {
      row,
      checkpoint: {
        schemaVersion: decoded.kind === 'scene' ? '1.0.0' : '2.0.0',
        codec: 'B',
        payload: Buffer.from(row.scenePayload),
        canonicalPayload: Buffer.from(decoded.canonicalBytes),
        canonicalBytes: row.sceneCanonicalBytes,
        storedBytes: row.sceneStoredBytes,
        sha256: Buffer.from(row.sceneSha256),
      },
      decoded,
      references,
    };
  }

  async revalidateRestore(
    connection: PoolConnection,
    boardPk: string,
    prepared: RestorePreparedV1,
    headSchemaVersion: string,
    boardId: BoardId,
  ): Promise<{
    checkpoint: EncodedBoardCheckpoint;
    references: readonly SceneArtifactReferenceRowV1[];
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
    if (!referenceRowsEqual(references, prepared.references)) {
      throw new BoardPersistenceError('row_integrity');
    }
    if (headSchemaVersion !== '1.0.0' && headSchemaVersion !== '2.0.0')
      throw new BoardPersistenceError('row_integrity');
    if (prepared.decoded.kind === 'scene' && headSchemaVersion === '2.0.0') {
      const document = adaptLegacySceneToDocumentV2({
        boardId,
        scene: prepared.decoded.scene,
      });
      return {
        checkpoint: await this.checkpoints.encodeDocument(document),
        references: extractDocumentArtifactReferences(document),
        sourceRevisionPk: row.revisionPk,
      };
    }
    return { checkpoint: prepared.checkpoint, references, sourceRevisionPk: row.revisionPk };
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
        (row.referenceCode !== 'A' && row.referenceCode !== 'I') ||
        !Number.isSafeInteger(row.occurrenceCount) ||
        row.occurrenceCount < 1 ||
        row.occurrenceCount > 500
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
}
