import type { PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';

import { BoardPersistenceError } from '../../common/errors/board-persistence.error.js';

export interface RetentionLeaseV1 {
  boardPk: string;
  runId: string;
  ownerToken: string;
  fence: string;
}

interface LeaseRow extends RowDataPacket {
  fence: string;
}

export class RetentionLockService {
  async acquire(
    connection: PoolConnection,
    input: Omit<RetentionLeaseV1, 'fence'>,
  ): Promise<RetentionLeaseV1 | null> {
    await connection.query('SET SESSION innodb_lock_wait_timeout = 2');
    const [insert] = await connection.execute<ResultSetHeader>(
      `
      INSERT INTO board_retention_leases (
        board_pk, run_id, owner_token, fence, lease_expires_at, renewed_at
      ) VALUES (?, ?, ?, 1, CURRENT_TIMESTAMP(3) + INTERVAL 60 SECOND, CURRENT_TIMESTAMP(3))
      ON DUPLICATE KEY UPDATE
        run_id = IF(lease_expires_at <= CURRENT_TIMESTAMP(3), VALUES(run_id), run_id),
        owner_token = IF(lease_expires_at <= CURRENT_TIMESTAMP(3), VALUES(owner_token), owner_token),
        fence = IF(lease_expires_at <= CURRENT_TIMESTAMP(3), fence + 1, fence),
        lease_expires_at = IF(
          lease_expires_at <= CURRENT_TIMESTAMP(3),
          CURRENT_TIMESTAMP(3) + INTERVAL 60 SECOND,
          lease_expires_at
        ),
        renewed_at = IF(
          lease_expires_at <= CURRENT_TIMESTAMP(3),
          CURRENT_TIMESTAMP(3),
          renewed_at
        )
    `,
      [input.boardPk, input.runId, input.ownerToken],
    );
    if (insert.affectedRows !== 1 && insert.affectedRows !== 2) return null;
    const [rows] = await connection.execute<LeaseRow[]>(
      `
      SELECT CAST(fence AS CHAR) AS fence
      FROM board_retention_leases
      WHERE board_pk = ? AND run_id = ? AND owner_token = ?
        AND lease_expires_at > CURRENT_TIMESTAMP(3)
      LIMIT 1
    `,
      [input.boardPk, input.runId, input.ownerToken],
    );
    const row = rows[0];
    return rows.length === 1 && row !== undefined ? { ...input, fence: row.fence } : null;
  }

  async renew(connection: PoolConnection, lease: RetentionLeaseV1): Promise<void> {
    const [result] = await connection.execute<ResultSetHeader>(
      `
      UPDATE board_retention_leases
      SET lease_expires_at = CURRENT_TIMESTAMP(3) + INTERVAL 60 SECOND,
          renewed_at = CURRENT_TIMESTAMP(3)
      WHERE board_pk = ? AND run_id = ? AND owner_token = ? AND fence = ?
        AND lease_expires_at > CURRENT_TIMESTAMP(3)
    `,
      [lease.boardPk, lease.runId, lease.ownerToken, lease.fence],
    );
    if (result.affectedRows !== 1) throw new BoardPersistenceError('row_integrity');
  }

  async assertOwned(connection: PoolConnection, lease: RetentionLeaseV1): Promise<void> {
    const [rows] = await connection.execute<RowDataPacket[]>(
      `
      SELECT board_pk
      FROM board_retention_leases
      WHERE board_pk = ? AND run_id = ? AND owner_token = ? AND fence = ?
        AND lease_expires_at > CURRENT_TIMESTAMP(3)
      FOR UPDATE
    `,
      [lease.boardPk, lease.runId, lease.ownerToken, lease.fence],
    );
    if (rows.length !== 1) throw new BoardPersistenceError('row_integrity');
  }
}
