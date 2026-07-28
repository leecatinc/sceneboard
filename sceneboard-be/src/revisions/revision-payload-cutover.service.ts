import type { PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';

import { BoardPersistenceError } from '../common/errors/board-persistence.error.js';
import {
  RETENTION_BATCH_MAX_STORED_BYTES,
  RETENTION_BATCH_MAX_REVISIONS,
} from './retention/retention.repository.js';

interface InlineRow extends RowDataPacket {
  revisionPk: string;
  schemaVersion: '1.0.0' | '2.0.0';
  codec: 'B';
  payload: Buffer;
  canonicalBytes: number;
  storedBytes: number;
  sha256: Buffer;
}

export interface RevisionPayloadCutoverBatchV1 {
  processed: number;
  storedBytes: number;
  nextRevisionPk: string | null;
}

const bounded = (rows: readonly InlineRow[]): InlineRow[] => {
  const result: InlineRow[] = [];
  let bytes = 0;
  for (const row of rows) {
    if (
      row.codec !== 'B' ||
      row.payload.byteLength !== row.storedBytes ||
      row.sha256.byteLength !== 32 ||
      row.storedBytes < 1 ||
      row.storedBytes > RETENTION_BATCH_MAX_STORED_BYTES
    ) {
      throw new BoardPersistenceError('checkpoint_integrity');
    }
    if (result.length >= RETENTION_BATCH_MAX_REVISIONS) break;
    if (result.length > 0 && bytes + row.storedBytes > RETENTION_BATCH_MAX_STORED_BYTES) break;
    result.push(row);
    bytes += row.storedBytes;
  }
  return result;
};

export class RevisionPayloadCutoverService {
  async backfillBatch(
    connection: PoolConnection,
    afterRevisionPk: string,
  ): Promise<RevisionPayloadCutoverBatchV1> {
    const rows = bounded(await this.readInlineBatch(connection, afterRevisionPk));
    for (const row of rows) {
      const [result] = await connection.execute<ResultSetHeader>(
        `
        INSERT INTO board_revision_payloads (
          revision_pk, schema_version, codec, canonical_bytes, stored_bytes,
          payload_sha256, payload, state
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'available')
        ON DUPLICATE KEY UPDATE revision_pk = VALUES(revision_pk)
      `,
        [
          row.revisionPk,
          row.schemaVersion,
          row.codec,
          row.canonicalBytes,
          row.storedBytes,
          row.sha256,
          row.payload,
        ],
      );
      if (result.affectedRows !== 1 && result.affectedRows !== 2) {
        throw new BoardPersistenceError('row_integrity');
      }
    }
    return this.report(rows);
  }

  async clearInlineBatch(
    connection: PoolConnection,
    afterRevisionPk: string,
  ): Promise<RevisionPayloadCutoverBatchV1> {
    const rows = bounded(await this.readInlineBatch(connection, afterRevisionPk));
    for (const row of rows) {
      const [result] = await connection.execute<ResultSetHeader>(
        `
        UPDATE board_revisions r
        JOIN board_revision_payloads p ON p.revision_pk = r.revision_pk
        SET r.scene_schema_version = NULL, r.scene_codec = NULL, r.scene_payload = NULL,
            r.scene_canonical_bytes = NULL, r.scene_stored_bytes = NULL, r.scene_sha256 = NULL
        WHERE r.revision_pk = ?
          AND p.schema_version = r.scene_schema_version
          AND p.codec = r.scene_codec
          AND p.canonical_bytes = r.scene_canonical_bytes
          AND p.stored_bytes = r.scene_stored_bytes
          AND p.payload_sha256 = r.scene_sha256
          AND p.payload = r.scene_payload
      `,
        [row.revisionPk],
      );
      if (result.affectedRows !== 1) throw new BoardPersistenceError('checkpoint_integrity');
    }
    return this.report(rows);
  }

  async certifyParity(connection: PoolConnection): Promise<boolean> {
    const [rows] = await connection.execute<RowDataPacket[]>(
      `
      SELECT
        SUM(CASE WHEN p.revision_pk IS NULL THEN 1 ELSE 0 END) AS missingDetached,
        SUM(CASE WHEN p.revision_pk IS NOT NULL AND (
          p.schema_version <> r.scene_schema_version OR p.codec <> r.scene_codec
          OR p.canonical_bytes <> r.scene_canonical_bytes
          OR p.stored_bytes <> r.scene_stored_bytes
          OR p.payload_sha256 <> r.scene_sha256 OR p.payload <> r.scene_payload
        ) THEN 1 ELSE 0 END) AS parityMismatch
      FROM board_revisions r
      LEFT JOIN board_revision_payloads p ON p.revision_pk = r.revision_pk
      WHERE r.scene_payload IS NOT NULL
    `,
    );
    const row = rows[0] as { missingDetached?: unknown; parityMismatch?: unknown } | undefined;
    return Number(row?.missingDetached ?? -1) === 0 && Number(row?.parityMismatch ?? -1) === 0;
  }

  private async readInlineBatch(
    connection: PoolConnection,
    afterRevisionPk: string,
  ): Promise<InlineRow[]> {
    const [rows] = await connection.execute<InlineRow[]>(
      `
      SELECT CAST(revision_pk AS CHAR) AS revisionPk,
             scene_schema_version AS schemaVersion, scene_codec AS codec,
             scene_payload AS payload, scene_canonical_bytes AS canonicalBytes,
             scene_stored_bytes AS storedBytes, scene_sha256 AS sha256
      FROM board_revisions
      WHERE revision_pk > ? AND scene_payload IS NOT NULL
      ORDER BY revision_pk ASC
      LIMIT 101
      FOR UPDATE
    `,
      [afterRevisionPk],
    );
    return rows;
  }

  private report(rows: readonly InlineRow[]): RevisionPayloadCutoverBatchV1 {
    return {
      processed: rows.length,
      storedBytes: rows.reduce((total, row) => total + row.storedBytes, 0),
      nextRevisionPk: rows.at(-1)?.revisionPk ?? null,
    };
  }
}
