import { timingSafeEqual } from 'node:crypto';

import type { PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';

import { ShareContractError } from '../common/errors/app-error.js';
import type { LockedShare, ShareOperation, ShareRepository } from './share.repository.js';
import { shareStateDigest } from './share.repository.js';

export type ShareRecoveryPhase = 'planned' | 'core_applied' | 'complete' | 'quarantined';
export type ShareRecoveryObserved = 'before' | 'after' | 'neither';
export type ShareRecoveryAction =
  | 'resume_core'
  | 'safe_abort'
  | 'adopt_core_applied'
  | 'committed_cleanup'
  | 'quarantine'
  | 'noop';

interface RecoveryRow extends RowDataPacket {
  recoveryId: string;
  sharePk: string | null;
  boardPk: string;
  operation: ShareOperation | 'archive';
  beforeSha256: Buffer;
  afterSha256: Buffer;
  phase: ShareRecoveryPhase;
  outcome: 'committed' | 'aborted' | null;
  leaseOwner: string | null;
  operatorFence: string;
  attempts: number;
}

interface RecoveryItemRow extends RowDataPacket {
  discoveryRecoveryId: string;
  revisionPk: string;
}

export const decideShareRecoveryAction = (
  phase: ShareRecoveryPhase,
  observed: ShareRecoveryObserved,
  outcome: 'committed' | 'aborted' | null,
): ShareRecoveryAction => {
  if (phase === 'complete') return outcome === null ? 'quarantine' : 'noop';
  if (phase === 'quarantined') {
    if (observed === 'before') return 'safe_abort';
    if (observed === 'after') return 'committed_cleanup';
    return 'quarantine';
  }
  if (phase === 'planned') {
    if (observed === 'before') return 'resume_core';
    if (observed === 'after') return 'adopt_core_applied';
    return 'quarantine';
  }
  return observed === 'after' ? 'committed_cleanup' : 'quarantine';
};

const equalDigest = (left: Uint8Array, right: Uint8Array): boolean =>
  left.byteLength === 32 && right.byteLength === 32 && timingSafeEqual(left, right);

export class ShareTransitionRecoveryService {
  constructor(private readonly shares: ShareRepository) {}

  async plan(
    connection: PoolConnection,
    input: {
      recoveryId: string;
      boardPk: bigint;
      sharePk: bigint | null;
      operation: ShareOperation | 'archive';
      fingerprintSha256: Buffer;
      beforeSha256: Buffer;
      afterSha256: Buffer;
      oldRevisionPk: bigint | null;
      newRevisionPk: bigint | null;
      leaseOwner: string;
      nowSql: string;
      credentialMarker?: {
        credentialVersion: number;
        passwordHashSha256: Buffer;
        pepperVersion: number;
      } | null;
    },
  ): Promise<void> {
    const [created] = await connection.execute<ResultSetHeader>(
      `INSERT INTO share_transition_recovery (
         recovery_id, share_pk, board_pk, operation, fingerprint_sha256,
         before_sha256, after_sha256, old_revision_pk, new_revision_pk,
         credential_present, credential_version, password_hash_sha256, pepper_version,
         phase, outcome, lease_owner, lease_expires_at, attempts, last_error,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'planned', NULL, ?,
                 ? + INTERVAL 60 SECOND, 0, NULL, ?, ?)`,
      [
        input.recoveryId,
        input.sharePk?.toString() ?? null,
        input.boardPk.toString(),
        input.operation,
        input.fingerprintSha256,
        input.beforeSha256,
        input.afterSha256,
        input.oldRevisionPk?.toString() ?? null,
        input.newRevisionPk?.toString() ?? null,
        input.credentialMarker === undefined || input.credentialMarker === null ? 0 : 1,
        input.credentialMarker?.credentialVersion ?? null,
        input.credentialMarker?.passwordHashSha256 ?? null,
        input.credentialMarker?.pepperVersion ?? null,
        input.leaseOwner,
        input.nowSql,
        input.nowSql,
        input.nowSql,
      ],
    );
    if (created.affectedRows !== 1) throw new ShareContractError('SHARE_STATE_CONFLICT');
    const revisions = [
      ...new Set([input.oldRevisionPk, input.newRevisionPk].filter(Boolean)),
    ] as bigint[];
    for (const revisionPk of revisions) {
      const discoveryRecoveryId = `${input.recoveryId}:${revisionPk}`;
      const [discovery] = await connection.execute<ResultSetHeader>(
        `INSERT INTO board_revision_recovery (
           recovery_id, board_pk, revision_pk, phase, lease_owner,
           lease_expires_at, attempts, last_error, updated_at
         ) VALUES (?, ?, ?, 'planned', ?, ? + INTERVAL 60 SECOND, 0, NULL, ?)`,
        [
          discoveryRecoveryId,
          input.boardPk.toString(),
          revisionPk.toString(),
          input.leaseOwner,
          input.nowSql,
          input.nowSql,
        ],
      );
      if (discovery.affectedRows !== 1) throw new ShareContractError('SHARE_STATE_CONFLICT');
      const [item] = await connection.execute<ResultSetHeader>(
        `INSERT INTO share_transition_recovery_items (
           discovery_recovery_id, share_transition_recovery_id, board_pk, revision_pk
         ) VALUES (?, ?, ?, ?)`,
        [discoveryRecoveryId, input.recoveryId, input.boardPk.toString(), revisionPk.toString()],
      );
      if (item.affectedRows !== 1) throw new ShareContractError('SHARE_STATE_CONFLICT');
      await this.shares.acquireHold(connection, {
        boardPk: input.boardPk,
        revisionPk,
        kind: 'recovery',
        holderId: this.shares.recoveryHolder(input.recoveryId),
      });
    }
  }

  async markCoreApplied(
    connection: PoolConnection,
    input: {
      recoveryId: string;
      sharePk: bigint;
      leaseOwner: string;
      nowSql: string;
    },
  ): Promise<void> {
    const recovery = await this.lock(connection, input.recoveryId);
    if (recovery.phase !== 'planned') throw new ShareContractError('SHARE_STATE_CONFLICT');
    const [updated] = await connection.execute<ResultSetHeader>(
      `UPDATE share_transition_recovery
       SET share_pk = ?, phase = 'core_applied', lease_owner = ?,
           lease_expires_at = ? + INTERVAL 60 SECOND, updated_at = ?
       WHERE recovery_id = ? AND phase = 'planned'`,
      [input.sharePk.toString(), input.leaseOwner, input.nowSql, input.nowSql, input.recoveryId],
    );
    if (updated.affectedRows !== 1) throw new ShareContractError('SHARE_STATE_CONFLICT');
    const items = await this.lockItems(connection, input.recoveryId);
    const [discoveries] = await connection.execute<ResultSetHeader>(
      `UPDATE board_revision_recovery r
       JOIN share_transition_recovery_items item
         ON item.discovery_recovery_id = r.recovery_id
       SET r.phase = 'core_applied', r.lease_owner = ?,
           r.lease_expires_at = ? + INTERVAL 60 SECOND,
           r.last_error = NULL, r.updated_at = ?
       WHERE item.share_transition_recovery_id = ?
         AND r.phase = 'planned'`,
      [input.leaseOwner, input.nowSql, input.nowSql, input.recoveryId],
    );
    if (discoveries.affectedRows !== items.length)
      throw new ShareContractError('SHARE_STATE_CONFLICT');
  }

  async complete(
    connection: PoolConnection,
    input: {
      recoveryId: string;
      share: LockedShare;
      leaseOwner: string;
      nowSql: string;
    },
  ): Promise<void> {
    const recovery = await this.lock(connection, input.recoveryId);
    if (
      recovery.phase !== 'core_applied' ||
      recovery.sharePk !== input.share.sharePk.toString() ||
      recovery.leaseOwner !== input.leaseOwner ||
      !equalDigest(recovery.afterSha256, shareStateDigest(input.share))
    ) {
      await this.quarantine(connection, recovery, 'AFTER_DIGEST_MISMATCH', input.nowSql);
      throw new ShareContractError('SHARE_STATE_CONFLICT');
    }
    const items = await this.lockItems(connection, input.recoveryId);
    for (const item of items) {
      await this.shares.releaseHold(connection, {
        boardPk: input.share.boardPk,
        revisionPk: BigInt(item.revisionPk),
        kind: 'recovery',
        holderId: this.shares.recoveryHolder(input.recoveryId),
        nowSql: input.nowSql,
      });
    }
    const [discoveries] = await connection.execute<ResultSetHeader>(
      `UPDATE board_revision_recovery r
       JOIN share_transition_recovery_items item
         ON item.discovery_recovery_id = r.recovery_id
       SET r.phase = 'complete', r.lease_owner = NULL, r.lease_expires_at = NULL,
           r.last_error = NULL, r.updated_at = ?
       WHERE item.share_transition_recovery_id = ?
         AND r.phase IN ('planned','core_applied','quarantined')`,
      [input.nowSql, input.recoveryId],
    );
    if (discoveries.affectedRows !== items.length)
      throw new ShareContractError('SHARE_STATE_CONFLICT');
    const [completed] = await connection.execute<ResultSetHeader>(
      `UPDATE share_transition_recovery
       SET phase = 'complete', outcome = 'committed', lease_owner = NULL,
           lease_expires_at = NULL, last_error = NULL, updated_at = ?
       WHERE recovery_id = ? AND phase = 'core_applied'`,
      [input.nowSql, input.recoveryId],
    );
    if (completed.affectedRows !== 1) throw new ShareContractError('SHARE_STATE_CONFLICT');
  }

  async recordFailure(
    connection: PoolConnection,
    recoveryId: string,
    errorCode: string,
    nowSql: string,
  ): Promise<ShareRecoveryPhase> {
    if (!/^[A-Z0-9_]{1,64}$/u.test(errorCode)) throw new TypeError('invalid share recovery error');
    const recovery = await this.lock(connection, recoveryId);
    if (recovery.phase === 'complete') return recovery.phase;
    const attempts = recovery.attempts + 1;
    const phase: ShareRecoveryPhase = attempts >= 10 ? 'quarantined' : recovery.phase;
    const [updated] = await connection.execute<ResultSetHeader>(
      `UPDATE share_transition_recovery
       SET attempts = ?, phase = ?, last_error = ?,
           lease_owner = IF(? = 'quarantined', NULL, lease_owner),
           lease_expires_at = IF(? = 'quarantined', NULL, lease_expires_at),
           updated_at = ?
       WHERE recovery_id = ? AND phase = ? AND attempts = ?`,
      [
        attempts,
        phase,
        errorCode,
        phase,
        phase,
        nowSql,
        recoveryId,
        recovery.phase,
        recovery.attempts,
      ],
    );
    if (updated.affectedRows !== 1) throw new ShareContractError('SHARE_STATE_CONFLICT');
    if (phase === 'quarantined') {
      const items = await this.lockItems(connection, recoveryId);
      const [discoveries] = await connection.execute<ResultSetHeader>(
        `UPDATE board_revision_recovery r
         JOIN share_transition_recovery_items item
           ON item.discovery_recovery_id = r.recovery_id
         SET r.phase = 'quarantined', r.attempts = ?,
             r.lease_owner = NULL, r.lease_expires_at = NULL,
             r.last_error = ?, r.updated_at = ?
         WHERE item.share_transition_recovery_id = ?`,
        [attempts, errorCode, nowSql, recoveryId],
      );
      if (discoveries.affectedRows !== items.length)
        throw new ShareContractError('SHARE_STATE_CONFLICT');
    }
    return phase;
  }

  async claim(
    connection: PoolConnection,
    input: {
      recoveryId: string;
      claimant: string;
      evidenceSha256: Buffer;
    },
  ): Promise<{ phase: ShareRecoveryPhase; fence: number }> {
    if (!/^[\x21-\x7e]{1,191}$/u.test(input.claimant) || input.evidenceSha256.byteLength !== 32) {
      throw new TypeError('invalid share recovery claim evidence');
    }
    const recovery = await this.lock(connection, input.recoveryId);
    if (recovery.phase === 'complete') {
      return { phase: recovery.phase, fence: this.safeFence(recovery.operatorFence) };
    }
    const [claimed] = await connection.execute<ResultSetHeader>(
      `UPDATE share_transition_recovery
       SET lease_owner = ?, lease_expires_at = CURRENT_TIMESTAMP(3) + INTERVAL 60 SECOND,
           operator_fence = operator_fence + 1, operator_claimant = ?,
           operator_evidence_sha256 = ?, attempts = LEAST(10, attempts + 1),
           last_error = NULL, updated_at = CURRENT_TIMESTAMP(3)
       WHERE recovery_id = ? AND phase <> 'complete'
         AND operator_fence < 9007199254740991
         AND (
           lease_owner = ?
           OR lease_expires_at IS NULL
           OR lease_expires_at <= CURRENT_TIMESTAMP(3)
         )`,
      [input.claimant, input.claimant, input.evidenceSha256, input.recoveryId, input.claimant],
    );
    if (claimed.affectedRows !== 1) throw new ShareContractError('SHARE_STATE_CONFLICT');
    const current = await this.lock(connection, input.recoveryId);
    const items = await this.lockItems(connection, input.recoveryId);
    const [discoveries] = await connection.execute<ResultSetHeader>(
      `UPDATE board_revision_recovery r
       JOIN share_transition_recovery_items item
         ON item.discovery_recovery_id = r.recovery_id
       SET r.lease_owner = ?,
           r.lease_expires_at = CURRENT_TIMESTAMP(3) + INTERVAL 60 SECOND,
           r.attempts = ?, r.last_error = NULL, r.updated_at = CURRENT_TIMESTAMP(3)
       WHERE item.share_transition_recovery_id = ?
         AND r.phase <> 'complete'`,
      [input.claimant, current.attempts, input.recoveryId],
    );
    if (discoveries.affectedRows !== items.length)
      throw new ShareContractError('SHARE_STATE_CONFLICT');
    return { phase: current.phase, fence: this.safeFence(current.operatorFence) };
  }

  async reconcileObserved(
    connection: PoolConnection,
    input: {
      recoveryId: string;
      claimant: string;
      share: LockedShare | null;
      nowSql: string;
    },
  ): Promise<'committed' | 'aborted' | 'noop'> {
    const recovery = await this.lock(connection, input.recoveryId);
    if (recovery.phase === 'complete') return 'noop';
    if (recovery.leaseOwner !== input.claimant)
      throw new ShareContractError('SHARE_STATE_CONFLICT');
    const observed = this.observe(recovery, input.share);
    const action = decideShareRecoveryAction(recovery.phase, observed, recovery.outcome);
    if (action === 'noop') return 'noop';
    if (action === 'resume_core' || action === 'safe_abort') {
      await this.abort(connection, recovery, input.share, input.claimant, input.nowSql);
      return 'aborted';
    }
    if (action === 'adopt_core_applied') {
      if (input.share === null) throw new ShareContractError('SHARE_STATE_CONFLICT');
      await this.adoptCoreApplied(connection, recovery, input.share, input.claimant, input.nowSql);
      await this.complete(connection, {
        recoveryId: input.recoveryId,
        share: input.share,
        leaseOwner: input.claimant,
        nowSql: input.nowSql,
      });
      return 'committed';
    }
    if (action === 'committed_cleanup') {
      if (input.share === null) throw new ShareContractError('SHARE_STATE_CONFLICT');
      await this.complete(connection, {
        recoveryId: input.recoveryId,
        share: input.share,
        leaseOwner: input.claimant,
        nowSql: input.nowSql,
      });
      return 'committed';
    }
    await this.quarantine(connection, recovery, 'OBSERVED_STATE_MISMATCH', input.nowSql);
    throw new ShareContractError('SHARE_STATE_CONFLICT');
  }

  async scan(connection: PoolConnection, limit = 100): Promise<string[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new TypeError('invalid share recovery scan limit');
    const [rows] = await connection.execute<Array<RowDataPacket & { recoveryId: string }>>(
      `SELECT recovery_id AS recoveryId
       FROM share_transition_recovery
       WHERE phase <> 'complete'
         AND (lease_expires_at IS NULL OR lease_expires_at <= CURRENT_TIMESTAMP(3))
       ORDER BY phase, lease_expires_at, recovery_id
       LIMIT ${limit}`,
    );
    return rows.map((row) => row.recoveryId);
  }

  observe(recovery: Pick<RecoveryRow, 'beforeSha256' | 'afterSha256'>, share: LockedShare | null) {
    const actual = shareStateDigest(share);
    if (equalDigest(actual, recovery.beforeSha256)) return 'before' as const;
    if (equalDigest(actual, recovery.afterSha256)) return 'after' as const;
    return 'neither' as const;
  }

  private async lock(connection: PoolConnection, recoveryId: string): Promise<RecoveryRow> {
    const [rows] = await connection.execute<RecoveryRow[]>(
      `SELECT recovery_id AS recoveryId, CAST(share_pk AS CHAR) AS sharePk,
              CAST(board_pk AS CHAR) AS boardPk, operation,
              before_sha256 AS beforeSha256, after_sha256 AS afterSha256,
              phase, outcome, lease_owner AS leaseOwner,
              CAST(operator_fence AS CHAR) AS operatorFence, attempts
       FROM share_transition_recovery
       WHERE recovery_id = ? FOR UPDATE`,
      [recoveryId],
    );
    const row = rows[0];
    if (rows.length !== 1 || row === undefined)
      throw new ShareContractError('SHARE_STATE_CONFLICT');
    return row;
  }

  private async lockItems(
    connection: PoolConnection,
    recoveryId: string,
  ): Promise<RecoveryItemRow[]> {
    const [rows] = await connection.execute<RecoveryItemRow[]>(
      `SELECT discovery_recovery_id AS discoveryRecoveryId,
              CAST(revision_pk AS CHAR) AS revisionPk
       FROM share_transition_recovery_items
       WHERE share_transition_recovery_id = ?
       ORDER BY revision_pk FOR UPDATE`,
      [recoveryId],
    );
    if (rows.length < 1 || rows.length > 2) throw new ShareContractError('SHARE_STATE_CONFLICT');
    return rows;
  }

  private async quarantine(
    connection: PoolConnection,
    recovery: RecoveryRow,
    errorCode: string,
    nowSql: string,
  ): Promise<void> {
    const attempts = Math.min(10, recovery.attempts + 1);
    const [transition] = await connection.execute<ResultSetHeader>(
      `UPDATE share_transition_recovery
       SET phase = 'quarantined', attempts = ?, last_error = ?,
           lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
       WHERE recovery_id = ?`,
      [attempts, errorCode, nowSql, recovery.recoveryId],
    );
    if (transition.affectedRows !== 1) throw new ShareContractError('SHARE_STATE_CONFLICT');
    const items = await this.lockItems(connection, recovery.recoveryId);
    const [discoveries] = await connection.execute<ResultSetHeader>(
      `UPDATE board_revision_recovery r
       JOIN share_transition_recovery_items item
         ON item.discovery_recovery_id = r.recovery_id
       SET r.phase = 'quarantined', r.attempts = ?,
           r.lease_owner = NULL, r.lease_expires_at = NULL,
           r.last_error = ?, r.updated_at = ?
       WHERE item.share_transition_recovery_id = ?
         AND r.phase <> 'complete'`,
      [attempts, errorCode, nowSql, recovery.recoveryId],
    );
    if (discoveries.affectedRows !== items.length)
      throw new ShareContractError('SHARE_STATE_CONFLICT');
  }

  private async abort(
    connection: PoolConnection,
    recovery: RecoveryRow,
    share: LockedShare | null,
    claimant: string,
    nowSql: string,
  ): Promise<void> {
    if (
      recovery.leaseOwner !== claimant ||
      !equalDigest(recovery.beforeSha256, shareStateDigest(share))
    ) {
      throw new ShareContractError('SHARE_STATE_CONFLICT');
    }
    const items = await this.lockItems(connection, recovery.recoveryId);
    for (const item of items) {
      await this.shares.releaseHold(connection, {
        boardPk: this.safePk(recovery.boardPk),
        revisionPk: this.safePk(item.revisionPk),
        kind: 'recovery',
        holderId: this.shares.recoveryHolder(recovery.recoveryId),
        nowSql,
      });
    }
    const [discoveries] = await connection.execute<ResultSetHeader>(
      `UPDATE board_revision_recovery r
       JOIN share_transition_recovery_items item
         ON item.discovery_recovery_id = r.recovery_id
       SET r.phase = 'complete', r.lease_owner = NULL, r.lease_expires_at = NULL,
           r.last_error = NULL, r.updated_at = ?
       WHERE item.share_transition_recovery_id = ?
         AND r.phase IN ('planned','quarantined')`,
      [nowSql, recovery.recoveryId],
    );
    if (discoveries.affectedRows !== items.length)
      throw new ShareContractError('SHARE_STATE_CONFLICT');
    const [transition] = await connection.execute<ResultSetHeader>(
      `UPDATE share_transition_recovery
       SET phase = 'complete', outcome = 'aborted', lease_owner = NULL,
           lease_expires_at = NULL, last_error = NULL, updated_at = ?
       WHERE recovery_id = ? AND phase IN ('planned','quarantined')
         AND lease_owner = ?`,
      [nowSql, recovery.recoveryId, claimant],
    );
    if (transition.affectedRows !== 1) throw new ShareContractError('SHARE_STATE_CONFLICT');
  }

  private async adoptCoreApplied(
    connection: PoolConnection,
    recovery: RecoveryRow,
    share: LockedShare,
    claimant: string,
    nowSql: string,
  ): Promise<void> {
    if (
      recovery.leaseOwner !== claimant ||
      !equalDigest(recovery.afterSha256, shareStateDigest(share))
    ) {
      throw new ShareContractError('SHARE_STATE_CONFLICT');
    }
    const [transition] = await connection.execute<ResultSetHeader>(
      `UPDATE share_transition_recovery
       SET share_pk = ?, phase = 'core_applied', updated_at = ?
       WHERE recovery_id = ? AND phase IN ('planned','quarantined')
         AND lease_owner = ?`,
      [share.sharePk.toString(), nowSql, recovery.recoveryId, claimant],
    );
    if (transition.affectedRows !== 1) throw new ShareContractError('SHARE_STATE_CONFLICT');
    const items = await this.lockItems(connection, recovery.recoveryId);
    const [discoveries] = await connection.execute<ResultSetHeader>(
      `UPDATE board_revision_recovery r
       JOIN share_transition_recovery_items item
         ON item.discovery_recovery_id = r.recovery_id
       SET r.phase = 'core_applied', r.lease_owner = ?,
           r.lease_expires_at = ? + INTERVAL 60 SECOND,
           r.last_error = NULL, r.updated_at = ?
       WHERE item.share_transition_recovery_id = ?
         AND r.phase IN ('planned','quarantined')`,
      [claimant, nowSql, nowSql, recovery.recoveryId],
    );
    if (discoveries.affectedRows !== items.length)
      throw new ShareContractError('SHARE_STATE_CONFLICT');
  }

  private safePk(value: string): bigint {
    if (!/^[1-9][0-9]{0,19}$/u.test(value)) throw new ShareContractError('SHARE_STATE_CONFLICT');
    const parsed = BigInt(value);
    if (parsed > 18_446_744_073_709_551_615n) throw new ShareContractError('SHARE_STATE_CONFLICT');
    return parsed;
  }

  private safeFence(value: string): number {
    if (!/^(?:0|[1-9][0-9]{0,15})$/u.test(value))
      throw new ShareContractError('SHARE_STATE_CONFLICT');
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed)) throw new ShareContractError('SHARE_STATE_CONFLICT');
    return parsed;
  }
}
