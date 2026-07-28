import { randomUUID } from 'node:crypto';

import type { PoolConnection, RowDataPacket } from 'mysql2/promise';

import { BoardPersistenceError } from '../../common/errors/board-persistence.error.js';
import { RetentionLockService } from './retention-lock.service.js';
import { RetentionService, type RetentionDryRunV1 } from './retention.service.js';

export interface RetentionStatusV1 {
  recoveryId: string;
  runId: string;
  revisionPk: string;
  phase: string;
  attempts: number;
  lastError: string | null;
  owner: string | null;
}

interface StatusRow extends RowDataPacket, RetentionStatusV1 {}

export class RetentionOperatorService {
  constructor(
    private readonly retention = new RetentionService(),
    private readonly locks = new RetentionLockService(),
  ) {}

  async status(connection: PoolConnection, boardPk: string): Promise<RetentionStatusV1[]> {
    const [rows] = await connection.execute<StatusRow[]>(
      `
      SELECT recovery_id AS recoveryId,
             SUBSTRING_INDEX(recovery_id, ':', 1) AS runId,
             CAST(revision_pk AS CHAR) AS revisionPk,
             phase, attempts, last_error AS lastError, lease_owner AS owner
      FROM board_revision_recovery
      WHERE board_pk = ?
      ORDER BY updated_at DESC, recovery_id DESC
      LIMIT 100
    `,
      [boardPk],
    );
    return rows.map((row) => ({
      recoveryId: row.recoveryId,
      runId: row.runId,
      revisionPk: row.revisionPk,
      phase: row.phase,
      attempts: row.attempts,
      lastError: row.lastError,
      owner: row.owner,
    }));
  }

  dryRun(
    connection: PoolConnection,
    boardPk: string,
    retainedCount: number,
  ): Promise<RetentionDryRunV1> {
    return this.retention.dryRun(connection, boardPk, retainedCount);
  }

  async resume(
    connection: PoolConnection,
    boardPk: string,
    recoveryId: string,
    ownerToken: string,
  ): Promise<{ runId: string; fence: string }> {
    if (!/^[A-Za-z0-9:_-]{3,191}$/u.test(recoveryId)) throw new TypeError('invalid recovery id');
    const [rows] = await connection.execute<RowDataPacket[]>(
      `
      SELECT CAST(revision_pk AS CHAR) AS revisionPk
      FROM board_revision_recovery
      WHERE recovery_id = ? AND board_pk = ? AND phase = 'quarantined'
      FOR UPDATE
    `,
      [recoveryId, boardPk],
    );
    if (rows.length !== 1) throw new BoardPersistenceError('row_integrity');
    const runId = randomUUID();
    const lease = await this.locks.acquire(connection, { boardPk, runId, ownerToken });
    if (lease === null) throw new BoardPersistenceError('row_integrity');
    return { runId, fence: lease.fence };
  }
}
