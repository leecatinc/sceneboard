import type { PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';

import { BoardPersistenceError } from '../common/errors/board-persistence.error.js';

export const EXPORT_HOLD_TTL_SECONDS_V1 = 180;
export const EXPORT_HOLD_RENEW_SECONDS_V1 = 30;

interface ActiveHoldRow extends RowDataPacket {
  holderId: string;
}

const assertDatabasePk = (value: bigint): void => {
  if (value < 1n || value > 18_446_744_073_709_551_615n)
    throw new TypeError('invalid export hold database key');
};

const assertHolderId = (value: string): void => {
  if (!/^[A-Za-z0-9_-]{1,191}$/u.test(value)) throw new TypeError('invalid export hold holder ID');
};

export type ExportRevisionHoldV1 = Readonly<{
  boardPk: bigint;
  revisionPk: bigint;
  holderId: string;
}>;

export class ExportRevisionHoldConflictV1 extends Error {
  constructor() {
    super('export revision hold is not owned');
    this.name = 'ExportRevisionHoldConflictV1';
  }
}

export class ExportRevisionHoldRepositoryV1 {
  async acquire(
    connection: PoolConnection,
    hold: ExportRevisionHoldV1,
  ): Promise<ExportRevisionHoldV1> {
    assertDatabasePk(hold.boardPk);
    assertDatabasePk(hold.revisionPk);
    assertHolderId(hold.holderId);
    const [active] = await connection.execute<ActiveHoldRow[]>(
      `SELECT holder_id AS holderId
       FROM board_revision_holds
       WHERE board_pk = ? AND revision_pk = ? AND kind = 'export'
         AND released_at IS NULL AND expires_at > CURRENT_TIMESTAMP(3)
       FOR UPDATE`,
      [hold.boardPk.toString(), hold.revisionPk.toString()],
    );
    if (active.some((row) => row.holderId !== hold.holderId))
      throw new ExportRevisionHoldConflictV1();
    const [result] = await connection.execute<ResultSetHeader>(
      `INSERT INTO board_revision_holds (
         board_pk, revision_pk, kind, holder_id, expires_at, released_at
       ) VALUES (
         ?, ?, 'export', ?,
         CURRENT_TIMESTAMP(3) + INTERVAL ${EXPORT_HOLD_TTL_SECONDS_V1} SECOND, NULL
       )
       ON DUPLICATE KEY UPDATE
         expires_at = VALUES(expires_at), released_at = NULL`,
      [hold.boardPk.toString(), hold.revisionPk.toString(), hold.holderId],
    );
    if (result.affectedRows < 1 || result.affectedRows > 2)
      throw new BoardPersistenceError('row_integrity');
    return Object.freeze({ ...hold });
  }

  async renew(connection: PoolConnection, hold: ExportRevisionHoldV1): Promise<void> {
    const [result] = await connection.execute<ResultSetHeader>(
      `UPDATE board_revision_holds
       SET expires_at = CURRENT_TIMESTAMP(3) + INTERVAL ${EXPORT_HOLD_TTL_SECONDS_V1} SECOND
       WHERE board_pk = ? AND revision_pk = ? AND kind = 'export' AND holder_id = ?
         AND released_at IS NULL AND expires_at > CURRENT_TIMESTAMP(3)`,
      [hold.boardPk.toString(), hold.revisionPk.toString(), hold.holderId],
    );
    if (result.affectedRows !== 1) throw new ExportRevisionHoldConflictV1();
  }

  async release(connection: PoolConnection, hold: ExportRevisionHoldV1): Promise<boolean> {
    const [result] = await connection.execute<ResultSetHeader>(
      `UPDATE board_revision_holds
       SET released_at = COALESCE(released_at, CURRENT_TIMESTAMP(3))
       WHERE board_pk = ? AND revision_pk = ? AND kind = 'export' AND holder_id = ?`,
      [hold.boardPk.toString(), hold.revisionPk.toString(), hold.holderId],
    );
    if (result.affectedRows > 1) throw new BoardPersistenceError('row_integrity');
    return result.affectedRows === 1;
  }

  async recoverExpired(connection: PoolConnection): Promise<number> {
    const [result] = await connection.execute<ResultSetHeader>(
      `UPDATE board_revision_holds
       SET released_at = CURRENT_TIMESTAMP(3)
       WHERE kind = 'export' AND released_at IS NULL
         AND expires_at <= CURRENT_TIMESTAMP(3)`,
    );
    return result.affectedRows;
  }
}
