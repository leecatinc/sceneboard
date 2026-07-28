import { createHash } from 'node:crypto';

import type { PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';

import { BoardPersistenceError } from '../../common/errors/board-persistence.error.js';
import type { RetentionLeaseV1 } from './retention-lock.service.js';

export const RETENTION_BATCH_MAX_REVISIONS = 100;
export const RETENTION_BATCH_MAX_STORED_BYTES = 33_554_432;

export interface RetentionCandidateV1 {
  revisionPk: string;
  revisionNumber: number;
  storedBytes: number;
  anchorSha256: Buffer;
  payloadSha256: Buffer;
}

interface CandidateRow extends RowDataPacket {
  revisionPk: string;
  revisionNumber: string;
  storedBytes: number;
  anchorSha256: Buffer;
  payloadSha256: Buffer;
  activeHoldCount: string;
}

const safePositive = (value: string): number => {
  const parsed = Number(value);
  if (!/^[1-9][0-9]*$/u.test(value) || !Number.isSafeInteger(parsed)) {
    throw new BoardPersistenceError('row_integrity');
  }
  return parsed;
};

export const boundRetentionCandidatesV1 = (
  rows: readonly RetentionCandidateV1[],
): RetentionCandidateV1[] => {
  const selected: RetentionCandidateV1[] = [];
  let storedBytes = 0;
  for (const row of rows) {
    if (
      !Number.isSafeInteger(row.storedBytes) ||
      row.storedBytes < 1 ||
      row.storedBytes > RETENTION_BATCH_MAX_STORED_BYTES ||
      row.anchorSha256.byteLength !== 32 ||
      row.payloadSha256.byteLength !== 32
    ) {
      throw new BoardPersistenceError('row_integrity');
    }
    if (selected.length >= RETENTION_BATCH_MAX_REVISIONS) break;
    if (selected.length > 0 && storedBytes + row.storedBytes > RETENTION_BATCH_MAX_STORED_BYTES) {
      break;
    }
    selected.push(row);
    storedBytes += row.storedBytes;
  }
  return selected;
};

export class RetentionRepository {
  async selectCandidates(
    connection: PoolConnection,
    boardPk: string,
    retainedCount: number,
    lock: boolean,
  ): Promise<RetentionCandidateV1[]> {
    if (!Number.isSafeInteger(retainedCount) || retainedCount < 1 || retainedCount > 256) {
      throw new TypeError('invalid retained revision count');
    }
    const [rows] = await connection.execute<CandidateRow[]>(
      `
      SELECT
        CAST(r.revision_pk AS CHAR) AS revisionPk,
        CAST(r.revision_number AS CHAR) AS revisionNumber,
        p.stored_bytes AS storedBytes,
        UNHEX(SHA2(CONCAT(
          HEX(r.revision_id), ':', CAST(r.revision_number AS CHAR), ':',
          IFNULL(CAST(r.previous_revision_pk AS CHAR), ''), ':',
          IFNULL(CAST(r.source_revision_pk AS CHAR), ''), ':', r.origin_code
        ), 256)) AS anchorSha256,
        p.payload_sha256 AS payloadSha256,
        CAST(SUM(
          CASE WHEN h.revision_pk IS NOT NULL
            AND h.released_at IS NULL
            AND (h.expires_at IS NULL OR h.expires_at > CURRENT_TIMESTAMP(3))
          THEN 1 ELSE 0 END
        ) AS CHAR) AS activeHoldCount
      FROM board_revision_catalog c
      JOIN board_revisions r ON r.board_pk = c.board_pk AND r.revision_pk = c.revision_pk
      JOIN board_revision_payloads p ON p.revision_pk = r.revision_pk AND p.state = 'available'
      LEFT JOIN board_revision_holds h
        ON h.board_pk = c.board_pk AND h.revision_pk = c.revision_pk
      WHERE c.board_pk = ?
        AND c.retained_order <= (
          SELECT IF(COUNT(*) > ?, MAX(newest.retained_order) - ?, 0)
          FROM board_revision_catalog newest
          WHERE newest.board_pk = c.board_pk
        )
        AND c.is_head = 0
      GROUP BY r.revision_pk, r.revision_number, p.stored_bytes, p.payload_sha256
      HAVING activeHoldCount = '0'
      ORDER BY r.revision_pk ASC
      LIMIT 101
      ${lock ? 'FOR UPDATE' : ''}
    `,
      [boardPk, retainedCount, retainedCount],
    );
    return boundRetentionCandidatesV1(
      rows.map((row) => ({
        revisionPk: row.revisionPk,
        revisionNumber: safePositive(row.revisionNumber),
        storedBytes: row.storedBytes,
        anchorSha256: Buffer.from(row.anchorSha256),
        payloadSha256: Buffer.from(row.payloadSha256),
      })),
    );
  }

  manifestDigest(candidates: readonly RetentionCandidateV1[]): Buffer {
    const canonical = candidates
      .map(
        (candidate) =>
          `${candidate.revisionPk}:${candidate.revisionNumber}:${candidate.storedBytes}:` +
          `${candidate.anchorSha256.toString('hex')}:${candidate.payloadSha256.toString('hex')}`,
      )
      .join('\n');
    return createHash('sha256').update(canonical, 'ascii').digest();
  }

  async persistPlan(
    connection: PoolConnection,
    lease: RetentionLeaseV1,
    candidates: readonly RetentionCandidateV1[],
    holdSnapshotSha256: Buffer,
  ): Promise<void> {
    const storedBytes = candidates.reduce((total, row) => total + row.storedBytes, 0);
    const manifest = this.manifestDigest(candidates);
    const [run] = await connection.execute<ResultSetHeader>(
      `
      INSERT INTO board_retention_runs (
        run_id, board_pk, state, attempt, candidate_count, stored_bytes,
        candidate_manifest_sha256, hold_snapshot_sha256, started_at, updated_at
      ) VALUES (?, ?, 'planned', 1, ?, ?, ?, ?, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))
    `,
      [lease.runId, lease.boardPk, candidates.length, storedBytes, manifest, holdSnapshotSha256],
    );
    if (run.affectedRows !== 1) throw new BoardPersistenceError('row_integrity');
    for (const [index, candidate] of candidates.entries()) {
      const recoveryId = `${lease.runId}:${candidate.revisionPk}`;
      const [item] = await connection.execute<ResultSetHeader>(
        `
        INSERT INTO board_retention_run_items (
          run_id, revision_pk, ordinal, anchor_sha256, payload_sha256, stored_bytes,
          hold_snapshot_sha256, phase, attempts, last_error, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'planned', 0, NULL, CURRENT_TIMESTAMP(3))
      `,
        [
          lease.runId,
          candidate.revisionPk,
          index + 1,
          candidate.anchorSha256,
          candidate.payloadSha256,
          candidate.storedBytes,
          holdSnapshotSha256,
        ],
      );
      if (item.affectedRows !== 1) throw new BoardPersistenceError('row_integrity');
      const [recovery] = await connection.execute<ResultSetHeader>(
        `
        INSERT INTO board_revision_recovery (
          recovery_id, board_pk, revision_pk, phase, lease_owner, lease_expires_at,
          attempts, last_error, updated_at
        ) VALUES (
          ?, ?, ?, 'planned', ?, CURRENT_TIMESTAMP(3) + INTERVAL 60 SECOND,
          0, NULL, CURRENT_TIMESTAMP(3)
        )
      `,
        [recoveryId, lease.boardPk, candidate.revisionPk, lease.ownerToken],
      );
      if (recovery.affectedRows !== 1) throw new BoardPersistenceError('row_integrity');
    }
  }
}
