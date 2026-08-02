import type { PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';

import { BoardPersistenceError } from '../common/errors/board-persistence.error.js';
import {
  RETENTION_BATCH_MAX_STORED_BYTES,
  RETENTION_BATCH_MAX_REVISIONS,
} from './retention/retention.repository.js';

interface InlineRow extends RowDataPacket {
  revisionPk: string;
  schemaVersion: '1.0.0' | '2.0.0' | '3.0.0';
  codec: 'B';
  payload: Buffer;
  canonicalBytes: number;
  storedBytes: number;
  sha256: Buffer;
}

interface DetachedRow extends RowDataPacket {
  schemaVersion: string;
  codec: string;
  canonicalBytes: number;
  storedBytes: number;
  sha256: Buffer;
  payload: Buffer;
  state: string;
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

const tuplesMatch = (inline: InlineRow, detached: DetachedRow): boolean =>
  inline.schemaVersion === detached.schemaVersion &&
  inline.codec === detached.codec &&
  inline.canonicalBytes === detached.canonicalBytes &&
  inline.storedBytes === detached.storedBytes &&
  Buffer.isBuffer(detached.sha256) &&
  inline.sha256.equals(detached.sha256) &&
  Buffer.isBuffer(detached.payload) &&
  inline.payload.equals(detached.payload);

export class RevisionPayloadCutoverService {
  async backfillBatch(
    connection: PoolConnection,
    afterRevisionPk: string,
  ): Promise<RevisionPayloadCutoverBatchV1> {
    const rows = bounded(await this.readInlineBatch(connection, afterRevisionPk));
    for (const row of rows) {
      const detached = await this.readDetachedCheckpoint(connection, row.revisionPk);
      if (detached === null) {
        const [inserted] = await connection.execute<ResultSetHeader>(
          `
          INSERT INTO board_revision_payloads (
            revision_pk, schema_version, codec, canonical_bytes, stored_bytes,
            payload_sha256, payload, state
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'available')
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
        if (inserted.affectedRows !== 1) throw new BoardPersistenceError('row_integrity');
        continue;
      }

      if (!tuplesMatch(row, detached)) throw new BoardPersistenceError('checkpoint_integrity');
      if (detached.state === 'available') continue;
      if (detached.state !== 'reclaiming') throw new BoardPersistenceError('checkpoint_integrity');

      const [recovered] = await connection.execute<ResultSetHeader>(
        `
        UPDATE board_revision_payloads
        SET state = 'available'
        WHERE revision_pk = ? AND state = 'reclaiming'
      `,
        [row.revisionPk],
      );
      if (recovered.affectedRows !== 1) throw new BoardPersistenceError('row_integrity');
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
          AND p.state = 'available'
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
        COALESCE(SUM(CASE WHEN p.revision_pk IS NULL THEN 1 ELSE 0 END), 0) AS missingDetached,
        COALESCE(SUM(CASE WHEN p.revision_pk IS NOT NULL AND (
          p.state <> 'available'
          OR p.schema_version <> r.scene_schema_version OR p.codec <> r.scene_codec
          OR p.canonical_bytes <> r.scene_canonical_bytes
          OR p.stored_bytes <> r.scene_stored_bytes
          OR p.payload_sha256 <> r.scene_sha256 OR p.payload <> r.scene_payload
        ) THEN 1 ELSE 0 END), 0) AS parityMismatch
      FROM board_revisions r
      LEFT JOIN board_revision_payloads p ON p.revision_pk = r.revision_pk
      WHERE r.scene_payload IS NOT NULL
    `,
    );
    const row = rows[0] as { missingDetached?: unknown; parityMismatch?: unknown } | undefined;
    const isZero = (value: unknown): boolean => value === 0 || value === '0';
    return rows.length === 1 && isZero(row?.missingDetached) && isZero(row?.parityMismatch);
  }

  private async readDetachedCheckpoint(
    connection: PoolConnection,
    revisionPk: string,
  ): Promise<DetachedRow | null> {
    const [rows] = await connection.execute<DetachedRow[]>(
      `
      SELECT schema_version AS schemaVersion, codec,
             canonical_bytes AS canonicalBytes, stored_bytes AS storedBytes,
             payload_sha256 AS sha256, payload, state
      FROM board_revision_payloads
      WHERE revision_pk = ?
      FOR UPDATE
    `,
      [revisionPk],
    );
    if (rows.length > 1) throw new BoardPersistenceError('row_integrity');
    return rows[0] ?? null;
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
