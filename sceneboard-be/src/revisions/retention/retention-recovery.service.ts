import { createHash } from 'node:crypto';

import type { PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';

import { BoardPersistenceError } from '../../common/errors/board-persistence.error.js';
import { RetentionLockService, type RetentionLeaseV1 } from './retention-lock.service.js';

export type RetentionItemPhaseV1 =
  | 'planned'
  | 'refs_detached'
  | 'payload_cleared'
  | 'catalog_removed'
  | 'complete'
  | 'quarantined';

interface ItemRow extends RowDataPacket {
  phase: RetentionItemPhaseV1;
  attempts: number;
  anchorSha256: Buffer;
  payloadSha256: Buffer;
  holdSnapshotSha256: Buffer;
}

interface CatalogPositionRow extends RowDataPacket {
  retainedOrder: string;
  oldestRetainedOrder: string;
}

const transitions: Readonly<
  Record<Exclude<RetentionItemPhaseV1, 'complete' | 'quarantined'>, RetentionItemPhaseV1>
> = {
  planned: 'refs_detached',
  refs_detached: 'payload_cleared',
  payload_cleared: 'catalog_removed',
  catalog_removed: 'complete',
};

export class RetentionRecoveryService {
  constructor(private readonly locks = new RetentionLockService()) {}

  async advance(
    connection: PoolConnection,
    lease: RetentionLeaseV1,
    revisionPk: string,
  ): Promise<RetentionItemPhaseV1> {
    await this.locks.assertOwned(connection, lease);
    const item = await this.lockItem(connection, lease.runId, revisionPk);
    if (item.phase === 'complete' || item.phase === 'quarantined') return item.phase;
    const next = transitions[item.phase];

    if (item.phase === 'planned') await this.detachReferences(connection, lease, revisionPk);
    if (item.phase === 'refs_detached') await this.clearPayload(connection, lease, revisionPk);
    if (item.phase === 'payload_cleared') await this.removeCatalog(connection, lease, revisionPk);
    if (item.phase === 'catalog_removed')
      await this.appendAudit(connection, lease, revisionPk, item);

    const [updated] = await connection.execute<ResultSetHeader>(
      `
      UPDATE board_retention_run_items item
      JOIN board_retention_leases lease
        ON lease.run_id = item.run_id
      SET item.phase = ?, item.last_error = NULL, item.updated_at = CURRENT_TIMESTAMP(3)
      WHERE item.run_id = ? AND item.revision_pk = ? AND item.phase = ?
        AND lease.board_pk = ? AND lease.owner_token = ? AND lease.fence = ?
        AND lease.lease_expires_at > CURRENT_TIMESTAMP(3)
    `,
      [next, lease.runId, revisionPk, item.phase, lease.boardPk, lease.ownerToken, lease.fence],
    );
    if (updated.affectedRows !== 1) throw new BoardPersistenceError('row_integrity');
    const recoveryId = `${lease.runId}:${revisionPk}`;
    const [recovery] = await connection.execute<ResultSetHeader>(
      `
      UPDATE board_revision_recovery
      SET phase = ?, lease_owner = IF(? = 'complete', NULL, ?),
          lease_expires_at = IF(? = 'complete', NULL, CURRENT_TIMESTAMP(3) + INTERVAL 60 SECOND),
          last_error = NULL, updated_at = CURRENT_TIMESTAMP(3)
      WHERE recovery_id = ? AND board_pk = ? AND revision_pk = ?
        AND lease_owner = ?
    `,
      [next, next, lease.ownerToken, next, recoveryId, lease.boardPk, revisionPk, lease.ownerToken],
    );
    if (recovery.affectedRows !== 1) throw new BoardPersistenceError('row_integrity');
    return next;
  }

  async recordFailure(
    connection: PoolConnection,
    lease: RetentionLeaseV1,
    revisionPk: string,
    errorCode: string,
  ): Promise<RetentionItemPhaseV1> {
    if (!/^[A-Z0-9_]{1,64}$/u.test(errorCode)) throw new TypeError('invalid retention error code');
    await this.locks.assertOwned(connection, lease);
    const item = await this.lockItem(connection, lease.runId, revisionPk);
    const attempts = item.attempts + 1;
    const phase: RetentionItemPhaseV1 = attempts >= 10 ? 'quarantined' : item.phase;
    const [updated] = await connection.execute<ResultSetHeader>(
      `
      UPDATE board_retention_run_items
      SET attempts = ?, phase = ?, last_error = ?, updated_at = CURRENT_TIMESTAMP(3)
      WHERE run_id = ? AND revision_pk = ? AND phase = ? AND attempts = ?
    `,
      [attempts, phase, errorCode, lease.runId, revisionPk, item.phase, item.attempts],
    );
    if (updated.affectedRows !== 1) throw new BoardPersistenceError('row_integrity');
    const [recovery] = await connection.execute<ResultSetHeader>(
      `
      UPDATE board_revision_recovery
      SET attempts = ?, phase = ?, last_error = ?,
          lease_owner = IF(? = 'quarantined', NULL, lease_owner),
          lease_expires_at = IF(? = 'quarantined', NULL, lease_expires_at),
          updated_at = CURRENT_TIMESTAMP(3)
      WHERE recovery_id = ? AND board_pk = ? AND revision_pk = ?
    `,
      [
        attempts,
        phase,
        errorCode,
        phase,
        phase,
        `${lease.runId}:${revisionPk}`,
        lease.boardPk,
        revisionPk,
      ],
    );
    if (recovery.affectedRows !== 1) throw new BoardPersistenceError('row_integrity');
    if (phase === 'quarantined') await this.appendAudit(connection, lease, revisionPk, item, phase);
    return phase;
  }

  private async lockItem(
    connection: PoolConnection,
    runId: string,
    revisionPk: string,
  ): Promise<ItemRow> {
    const [rows] = await connection.execute<ItemRow[]>(
      `
      SELECT phase, attempts, anchor_sha256 AS anchorSha256,
             payload_sha256 AS payloadSha256, hold_snapshot_sha256 AS holdSnapshotSha256
      FROM board_retention_run_items
      WHERE run_id = ? AND revision_pk = ?
      FOR UPDATE
    `,
      [runId, revisionPk],
    );
    const row = rows[0];
    if (rows.length !== 1 || row === undefined) throw new BoardPersistenceError('row_integrity');
    return row;
  }

  private async detachReferences(
    connection: PoolConnection,
    lease: RetentionLeaseV1,
    revisionPk: string,
  ): Promise<void> {
    const [holds] = await connection.execute<RowDataPacket[]>(
      `
      SELECT kind
      FROM board_revision_holds
      WHERE board_pk = ? AND revision_pk = ? AND released_at IS NULL
        AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP(3))
      FOR UPDATE
    `,
      [lease.boardPk, revisionPk],
    );
    if (holds.length > 0) throw new BoardPersistenceError('row_integrity');
    await connection.execute<ResultSetHeader>(
      'DELETE FROM board_revision_artifact_refs WHERE revision_pk = ?',
      [revisionPk],
    );
  }

  private async clearPayload(
    connection: PoolConnection,
    lease: RetentionLeaseV1,
    revisionPk: string,
  ): Promise<void> {
    const [result] = await connection.execute<ResultSetHeader>(
      `
      DELETE p
      FROM board_revision_payloads p
      JOIN board_revisions r ON r.revision_pk = p.revision_pk
      WHERE p.revision_pk = ? AND r.board_pk = ?
        AND r.scene_schema_version IS NULL AND r.scene_codec IS NULL
        AND r.scene_payload IS NULL AND r.scene_canonical_bytes IS NULL
        AND r.scene_stored_bytes IS NULL AND r.scene_sha256 IS NULL
    `,
      [revisionPk, lease.boardPk],
    );
    if (result.affectedRows > 1) throw new BoardPersistenceError('row_integrity');
  }

  private async removeCatalog(
    connection: PoolConnection,
    lease: RetentionLeaseV1,
    revisionPk: string,
  ): Promise<void> {
    const [positions] = await connection.execute<CatalogPositionRow[]>(
      `
      SELECT CAST(c.retained_order AS CHAR) AS retainedOrder,
             CAST((
               SELECT MIN(oldest.retained_order)
               FROM board_revision_catalog oldest
               WHERE oldest.board_pk = c.board_pk
             ) AS CHAR) AS oldestRetainedOrder
      FROM board_revision_catalog c
      WHERE c.board_pk = ? AND c.revision_pk = ? AND c.is_head = 0
      FOR UPDATE
    `,
      [lease.boardPk, revisionPk],
    );
    const position = positions[0];
    if (positions.length === 0) return;
    if (positions.length !== 1 || position === undefined) {
      throw new BoardPersistenceError('row_integrity');
    }
    const [result] = await connection.execute<ResultSetHeader>(
      `
      DELETE FROM board_revision_catalog
      WHERE board_pk = ? AND revision_pk = ? AND is_head = 0
    `,
      [lease.boardPk, revisionPk],
    );
    if (result.affectedRows !== 1) throw new BoardPersistenceError('row_integrity');
    if (position.retainedOrder === position.oldestRetainedOrder) {
      const [boundary] = await connection.execute<ResultSetHeader>(
        `
        UPDATE board_revision_catalog
        SET truncated_before = 1
        WHERE board_pk = ? AND retained_order = (
          SELECT retained_order
          FROM (
            SELECT MIN(next_oldest.retained_order) AS retained_order
            FROM board_revision_catalog next_oldest
            WHERE next_oldest.board_pk = ?
          ) AS retained_boundary
        )
      `,
        [lease.boardPk, lease.boardPk],
      );
      if (boundary.affectedRows > 1) throw new BoardPersistenceError('row_integrity');
    }
  }

  private async appendAudit(
    connection: PoolConnection,
    lease: RetentionLeaseV1,
    revisionPk: string,
    item: ItemRow,
    outcome: 'complete' | 'quarantined' = 'complete',
  ): Promise<void> {
    const evidence = createHash('sha256')
      .update(item.anchorSha256)
      .update(item.payloadSha256)
      .update(item.holdSnapshotSha256)
      .update(outcome, 'ascii')
      .digest();
    const [result] = await connection.execute<ResultSetHeader>(
      `
      INSERT INTO board_retention_audit (
        run_id, revision_pk, fence, outcome, completed_at, evidence_sha256
      ) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP(3), ?)
    `,
      [lease.runId, revisionPk, lease.fence, outcome, evidence],
    );
    if (result.affectedRows !== 1) throw new BoardPersistenceError('row_integrity');
  }
}
