import { createHash, timingSafeEqual } from 'node:crypto';

import type { PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';

import { BoardPersistenceError } from '../common/errors/board-persistence.error.js';
import { CryptoService } from '../common/security/crypto.service.js';
import type {
  MediaCleanupItemV1,
  MediaCleanupLeaseV1,
  MediaCleanupPhaseV1,
} from './media-retention.types.js';
import { MediaRepository } from './media.repository.js';
import { MediaWriterGate } from './media-writer-gate.js';

interface ItemRow extends RowDataPacket {
  cleanupId: string;
  boardPk: string;
  boardMediaPk: string;
  mediaPk: string;
  expectedBoardMediaVersion: string;
  expectedObjectVersion: string;
  phase: MediaCleanupPhaseV1;
  attempts: number;
  objectSha256: Buffer;
  byteLength: number;
  deleteAfter: string | null;
  backupDeploymentId: string | null;
  backupAttemptSeq: string | null;
  backupManifestSha256: Buffer | null;
}

interface ClockRow extends RowDataPacket {
  nowSql: string;
}

interface CertificateRow extends RowDataPacket {
  deploymentId: string;
  attemptSeq: string;
  sourceBackupSha256Hex: string;
  mediaManifestSha256Hex: string;
  certifiedAt: string;
  expiresAt: string;
  backupOk: number;
  restoreOk: number;
  integrityOk: number;
  signature: Buffer;
  mediaManifestSha256: Buffer;
}

const pk = (value: string): bigint => {
  if (!/^[1-9][0-9]*$/u.test(value)) throw new BoardPersistenceError('row_integrity');
  return BigInt(value);
};

const digestEquals = (left: Buffer, right: Buffer): boolean =>
  left.byteLength === right.byteLength && timingSafeEqual(left, right);

export const canonicalMediaBackupCertificate = (row: {
  deploymentId: string;
  attemptSeq: string;
  sourceBackupSha256Hex: string;
  mediaManifestSha256Hex: string;
  certifiedAt: string;
  expiresAt: string;
  backupOk: number;
  restoreOk: number;
  integrityOk: number;
}): Buffer =>
  Buffer.from(
    JSON.stringify({
      version: 1,
      deploymentId: row.deploymentId,
      attemptSeq: row.attemptSeq,
      sourceBackupSha256: row.sourceBackupSha256Hex,
      mediaManifestSha256: row.mediaManifestSha256Hex,
      certifiedAt: row.certifiedAt,
      expiresAt: row.expiresAt,
      backupOk: row.backupOk === 1,
      restoreOk: row.restoreOk === 1,
      integrityOk: row.integrityOk === 1,
    }),
    'utf8',
  );

export class MediaRecoveryService {
  constructor(
    private readonly media: MediaRepository,
    private readonly crypto: CryptoService,
    private readonly gate: MediaWriterGate | null = null,
  ) {}

  async advance(
    connection: PoolConnection,
    lease: MediaCleanupLeaseV1,
    cleanupId: bigint,
  ): Promise<MediaCleanupPhaseV1> {
    this.gate?.assertRetentionReady();
    await this.assertLease(connection, lease);
    const item = await this.lockItem(connection, cleanupId);
    if (item.phase === 'complete' || item.phase === 'quarantined') return item.phase;
    const nowSql = await this.databaseNow(connection);
    if (item.phase === 'intent') return this.quarantineOwnership(connection, lease, item, nowSql);
    if (item.phase === 'ownership_quarantined')
      return this.recheckReferences(connection, lease, item, nowSql);
    if (item.phase === 'refs_rechecked')
      return this.releaseOwnership(connection, lease, item, nowSql);
    if (item.phase === 'ownership_released')
      return this.quarantineObject(connection, lease, item, nowSql);
    if (item.phase === 'object_quarantined')
      return this.deleteObject(connection, lease, item, nowSql);
    if (item.phase === 'object_deleted') return this.complete(connection, lease, item, nowSql);
    throw new BoardPersistenceError('row_integrity');
  }

  async recordFailure(
    connection: PoolConnection,
    lease: MediaCleanupLeaseV1,
    cleanupId: bigint,
    errorCode: string,
  ): Promise<MediaCleanupPhaseV1> {
    this.gate?.assertRetentionReady();
    if (!/^[A-Z0-9_]{1,64}$/u.test(errorCode)) throw new TypeError('invalid media cleanup error');
    await this.assertLease(connection, lease);
    const item = await this.lockItem(connection, cleanupId);
    const attempts = item.attempts + 1;
    const phase = attempts >= 10 ? 'quarantined' : item.phase;
    const [updated] = await connection.execute<ResultSetHeader>(
      `
      UPDATE media_cleanup_items item
      JOIN media_cleanup_runs run ON run.run_id = item.run_id
      SET item.attempts = ?, item.phase = ?, item.last_error = ?,
          item.updated_at = UTC_TIMESTAMP(3)
      WHERE item.cleanup_id = ? AND item.phase = ? AND item.attempts = ?
        AND run.run_id = ? AND run.lease_owner = ? AND run.fence = ?
        AND run.state = 'running' AND run.lease_expires_at > UTC_TIMESTAMP(3)
    `,
      [
        attempts,
        phase,
        errorCode,
        cleanupId.toString(),
        item.phase,
        item.attempts,
        lease.runId,
        lease.leaseOwner,
        lease.fence.toString(),
      ],
    );
    if (updated.affectedRows !== 1) throw new BoardPersistenceError('row_integrity');
    return phase;
  }

  async reconcileBoard(connection: PoolConnection, boardPk: bigint): Promise<void> {
    this.gate?.assertRetentionReady();
    await connection.execute<RowDataPacket[]>(
      `
      SELECT r.revision_pk
      FROM board_revisions r
      JOIN board_revision_catalog c
        ON c.board_pk = r.board_pk AND c.revision_pk = r.revision_pk
      WHERE r.board_pk = ?
      ORDER BY r.revision_pk ASC
      FOR UPDATE
    `,
      [boardPk.toString()],
    );
    await connection.execute<RowDataPacket[]>(
      `
      SELECT ref.revision_pk, ref.media_id
      FROM board_revision_media_refs ref
      WHERE ref.board_pk = ?
      ORDER BY ref.revision_pk ASC, ref.ordinal ASC
      FOR UPDATE
    `,
      [boardPk.toString()],
    );
    await this.media.reconcileBoardQuota(connection, boardPk);
  }

  private async quarantineOwnership(
    connection: PoolConnection,
    lease: MediaCleanupLeaseV1,
    item: MediaCleanupItemV1,
    nowSql: string,
  ): Promise<MediaCleanupPhaseV1> {
    const [updated] = await connection.execute<ResultSetHeader>(
      `
      UPDATE board_media
      SET status = 'quarantined', version = version + 1, updated_at = ?
      WHERE board_media_pk = ? AND board_pk = ? AND media_pk = ?
        AND status = 'active' AND version = ? AND lease_expires_at <= ?
    `,
      [
        nowSql,
        item.boardMediaPk.toString(),
        item.boardPk.toString(),
        item.mediaPk.toString(),
        item.expectedBoardMediaVersion.toString(),
        nowSql,
      ],
    );
    if (updated.affectedRows !== 1) throw new BoardPersistenceError('row_integrity');
    return this.transition(connection, lease, item, 'ownership_quarantined', nowSql, {
      expectedBoardMediaVersion: item.expectedBoardMediaVersion + 1n,
      ownershipQuarantinedAt: nowSql,
    });
  }

  private async recheckReferences(
    connection: PoolConnection,
    lease: MediaCleanupLeaseV1,
    item: MediaCleanupItemV1,
    nowSql: string,
  ): Promise<MediaCleanupPhaseV1> {
    const holds = await this.media.lockStrongMediaHolds(connection, {
      boardPk: item.boardPk,
      mediaPk: item.mediaPk,
    });
    const hasRefs = await this.media.hasAnyExactMediaRef(connection, item.mediaPk);
    if (holds.length !== 0 || hasRefs) {
      const [restored] = await connection.execute<ResultSetHeader>(
        `
        UPDATE board_media
        SET status = 'active', version = version + 1, updated_at = ?
        WHERE board_media_pk = ? AND status = 'quarantined' AND version = ?
      `,
        [nowSql, item.boardMediaPk.toString(), item.expectedBoardMediaVersion.toString()],
      );
      if (restored.affectedRows !== 1) throw new BoardPersistenceError('row_integrity');
      return this.transition(connection, lease, item, 'complete', nowSql, {
        expectedBoardMediaVersion: item.expectedBoardMediaVersion + 1n,
        completionEvidence: createHash('sha256')
          .update('ownership-restored\0', 'ascii')
          .update(item.objectSha256)
          .digest(),
      });
    }
    return this.transition(connection, lease, item, 'refs_rechecked', nowSql);
  }

  private async releaseOwnership(
    connection: PoolConnection,
    lease: MediaCleanupLeaseV1,
    item: MediaCleanupItemV1,
    nowSql: string,
  ): Promise<MediaCleanupPhaseV1> {
    const released = await this.media.releaseExpiredOwnership(
      connection,
      item.boardMediaPk,
      item.expectedBoardMediaVersion,
      nowSql,
    );
    if (!released) throw new BoardPersistenceError('row_integrity');
    return this.transition(connection, lease, item, 'ownership_released', nowSql, {
      expectedBoardMediaVersion: item.expectedBoardMediaVersion + 1n,
    });
  }

  private async quarantineObject(
    connection: PoolConnection,
    lease: MediaCleanupLeaseV1,
    item: MediaCleanupItemV1,
    nowSql: string,
  ): Promise<MediaCleanupPhaseV1> {
    await this.lockExpectedObject(connection, item, 'active');
    if (await this.media.countLiveOwnerships(connection, item.mediaPk))
      return this.transition(connection, lease, item, 'complete', nowSql, {
        completionEvidence: createHash('sha256')
          .update('ownership-remains\0', 'ascii')
          .update(item.objectSha256)
          .digest(),
      });
    if (
      (
        await this.media.lockStrongMediaHolds(connection, {
          boardPk: item.boardPk,
          mediaPk: item.mediaPk,
        })
      ).length !== 0 ||
      (await this.media.hasAnyExactMediaRef(connection, item.mediaPk))
    )
      throw new BoardPersistenceError('row_integrity');
    const [updated] = await connection.execute<ResultSetHeader>(
      `
      UPDATE media_objects
      SET state = 'quarantined', version = version + 1, updated_at = ?
      WHERE media_pk = ? AND state = 'active' AND version = ?
        AND sha256 = ? AND byte_length = ?
    `,
      [
        nowSql,
        item.mediaPk.toString(),
        item.expectedObjectVersion.toString(),
        item.objectSha256,
        item.byteLength,
      ],
    );
    if (updated.affectedRows !== 1) throw new BoardPersistenceError('row_integrity');
    return this.transition(connection, lease, item, 'object_quarantined', nowSql, {
      expectedObjectVersion: item.expectedObjectVersion + 1n,
      objectQuarantinedAt: nowSql,
      deleteAfterExpression: true,
    });
  }

  private async deleteObject(
    connection: PoolConnection,
    lease: MediaCleanupLeaseV1,
    item: MediaCleanupItemV1,
    nowSql: string,
  ): Promise<MediaCleanupPhaseV1> {
    if (item.deleteAfter === null || nowSql < item.deleteAfter)
      throw new BoardPersistenceError('row_integrity');
    await this.lockExpectedObject(connection, item, 'quarantined');
    if (
      (await this.media.countLiveOwnerships(connection, item.mediaPk)) !== 0 ||
      (
        await this.media.lockStrongMediaHolds(connection, {
          boardPk: item.boardPk,
          mediaPk: item.mediaPk,
        })
      ).length !== 0 ||
      (await this.media.hasAnyExactMediaRef(connection, item.mediaPk))
    )
      throw new BoardPersistenceError('row_integrity');
    const certificate = await this.lockCertificate(connection, item, nowSql);
    await connection.execute<ResultSetHeader>(
      `
      DELETE FROM board_media
      WHERE media_pk = ? AND status = 'released'
    `,
      [item.mediaPk.toString()],
    );
    const [deleted] = await connection.execute<ResultSetHeader>(
      `
      DELETE FROM media_objects
      WHERE media_pk = ? AND state = 'quarantined' AND version = ?
        AND sha256 = ? AND byte_length = ?
    `,
      [
        item.mediaPk.toString(),
        item.expectedObjectVersion.toString(),
        item.objectSha256,
        item.byteLength,
      ],
    );
    if (deleted.affectedRows !== 1) throw new BoardPersistenceError('row_integrity');
    const evidence = createHash('sha256')
      .update(item.objectSha256)
      .update(String(item.byteLength), 'ascii')
      .update(certificate.mediaManifestSha256)
      .digest();
    return this.transition(connection, lease, item, 'object_deleted', nowSql, {
      completionEvidence: evidence,
    });
  }

  private async lockExpectedObject(
    connection: PoolConnection,
    item: MediaCleanupItemV1,
    state: 'active' | 'quarantined',
  ): Promise<void> {
    const object = await this.media.getCanonicalObject(connection, item.mediaPk);
    if (
      object === null ||
      object.state !== state ||
      object.version !== item.expectedObjectVersion ||
      object.byteLength !== item.byteLength ||
      !digestEquals(object.sha256, item.objectSha256) ||
      !digestEquals(createHash('sha256').update(object.bytes).digest(), item.objectSha256)
    )
      throw new BoardPersistenceError('row_integrity');
  }

  private async complete(
    connection: PoolConnection,
    lease: MediaCleanupLeaseV1,
    item: MediaCleanupItemV1,
    nowSql: string,
  ): Promise<MediaCleanupPhaseV1> {
    return this.transition(connection, lease, item, 'complete', nowSql);
  }

  private async lockCertificate(
    connection: PoolConnection,
    item: MediaCleanupItemV1,
    nowSql: string,
  ): Promise<CertificateRow> {
    const [rows] = await connection.execute<CertificateRow[]>(
      `
      SELECT certificate.deployment_id AS deploymentId,
             CAST(certificate.attempt_seq AS CHAR) AS attemptSeq,
             LOWER(HEX(certificate.source_backup_sha256)) AS sourceBackupSha256Hex,
             LOWER(HEX(certificate.media_manifest_sha256)) AS mediaManifestSha256Hex,
             DATE_FORMAT(certificate.certified_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS certifiedAt,
             DATE_FORMAT(certificate.expires_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS expiresAt,
             certificate.backup_ok AS backupOk, certificate.restore_ok AS restoreOk,
             certificate.integrity_ok AS integrityOk, certificate.signature,
             certificate.media_manifest_sha256 AS mediaManifestSha256
      FROM media_backup_certificates certificate
      JOIN media_backup_certificate_objects object
        ON object.deployment_id = certificate.deployment_id
          AND object.attempt_seq = certificate.attempt_seq
      WHERE object.media_pk = ? AND object.object_version = ?
        AND object.sha256 = ? AND object.byte_length = ?
        AND certificate.deployment_id = ? AND certificate.attempt_seq = ?
        AND certificate.media_manifest_sha256 = ?
        AND certificate.backup_ok = 1 AND certificate.restore_ok = 1
        AND certificate.integrity_ok = 1 AND certificate.expires_at > ?
        AND certificate.attempt_seq = (
          SELECT MAX(latest.attempt_seq)
          FROM media_backup_certificates latest
          WHERE latest.deployment_id = certificate.deployment_id
        )
      ORDER BY certificate.deployment_id ASC
      FOR UPDATE
    `,
      [
        item.mediaPk.toString(),
        item.expectedObjectVersion.toString(),
        item.objectSha256,
        item.byteLength,
        item.backupDeploymentId,
        item.backupAttemptSeq?.toString() ?? null,
        item.backupManifestSha256,
        nowSql,
      ],
    );
    const row = rows[0];
    if (
      item.backupDeploymentId === null ||
      item.backupAttemptSeq === null ||
      item.backupManifestSha256 === null ||
      rows.length !== 1 ||
      row === undefined ||
      !Buffer.isBuffer(row.mediaManifestSha256) ||
      row.mediaManifestSha256.byteLength !== 32 ||
      !Buffer.isBuffer(row.signature) ||
      row.signature.byteLength !== 32
    )
      throw new BoardPersistenceError('row_integrity');
    const canonical = canonicalMediaBackupCertificate(row);
    const expectedSignature = this.crypto.hmac('audit-media-backup-certificate/v1', canonical);
    if (!digestEquals(expectedSignature, row.signature))
      throw new BoardPersistenceError('row_integrity');
    return row;
  }

  private async assertLease(connection: PoolConnection, lease: MediaCleanupLeaseV1): Promise<void> {
    const [rows] = await connection.execute<RowDataPacket[]>(
      `
      SELECT run_id
      FROM media_cleanup_runs
      WHERE run_id = ? AND lease_owner = ? AND fence = ?
        AND state = 'running' AND lease_expires_at > UTC_TIMESTAMP(3)
      FOR UPDATE
    `,
      [lease.runId, lease.leaseOwner, lease.fence.toString()],
    );
    if (rows.length !== 1) throw new BoardPersistenceError('row_integrity');
  }

  private async lockItem(
    connection: PoolConnection,
    cleanupId: bigint,
  ): Promise<MediaCleanupItemV1> {
    const [rows] = await connection.execute<ItemRow[]>(
      `
      SELECT CAST(cleanup_id AS CHAR) AS cleanupId, CAST(board_pk AS CHAR) AS boardPk,
             CAST(board_media_pk AS CHAR) AS boardMediaPk, CAST(media_pk AS CHAR) AS mediaPk,
             CAST(expected_board_media_version AS CHAR) AS expectedBoardMediaVersion,
             CAST(expected_object_version AS CHAR) AS expectedObjectVersion,
             phase, attempts, object_sha256 AS objectSha256, byte_length AS byteLength,
             DATE_FORMAT(delete_after, '%Y-%m-%d %H:%i:%s.%f') AS deleteAfter,
             backup_deployment_id AS backupDeploymentId,
             CAST(backup_attempt_seq AS CHAR) AS backupAttemptSeq,
             backup_manifest_sha256 AS backupManifestSha256
      FROM media_cleanup_items WHERE cleanup_id = ? FOR UPDATE
    `,
      [cleanupId.toString()],
    );
    const row = rows[0];
    if (
      rows.length !== 1 ||
      row === undefined ||
      !Buffer.isBuffer(row.objectSha256) ||
      row.objectSha256.byteLength !== 32
    )
      throw new BoardPersistenceError('row_integrity');
    return Object.freeze({
      cleanupId: pk(row.cleanupId),
      boardPk: pk(row.boardPk),
      boardMediaPk: pk(row.boardMediaPk),
      mediaPk: pk(row.mediaPk),
      expectedBoardMediaVersion: pk(row.expectedBoardMediaVersion),
      expectedObjectVersion: pk(row.expectedObjectVersion),
      phase: row.phase,
      attempts: row.attempts,
      objectSha256: row.objectSha256,
      byteLength: row.byteLength,
      deleteAfter: row.deleteAfter,
      backupDeploymentId: row.backupDeploymentId,
      backupAttemptSeq: row.backupAttemptSeq === null ? null : pk(row.backupAttemptSeq),
      backupManifestSha256:
        row.backupManifestSha256 === null ? null : Buffer.from(row.backupManifestSha256),
    });
  }

  private async transition(
    connection: PoolConnection,
    lease: MediaCleanupLeaseV1,
    item: MediaCleanupItemV1,
    next: MediaCleanupPhaseV1,
    nowSql: string,
    options: {
      expectedBoardMediaVersion?: bigint;
      expectedObjectVersion?: bigint;
      ownershipQuarantinedAt?: string;
      objectQuarantinedAt?: string;
      deleteAfterExpression?: boolean;
      completionEvidence?: Buffer;
    } = {},
  ): Promise<MediaCleanupPhaseV1> {
    const [updated] = await connection.execute<ResultSetHeader>(
      `
      UPDATE media_cleanup_items item
      JOIN media_cleanup_runs run ON run.run_id = item.run_id
      SET item.phase = ?,
          item.expected_board_media_version = ?,
          item.expected_object_version = ?,
          item.ownership_quarantined_at = COALESCE(?, item.ownership_quarantined_at),
          item.object_quarantined_at = COALESCE(?, item.object_quarantined_at),
          item.delete_after = IF(?, DATE_ADD(?, INTERVAL 7 DAY), item.delete_after),
          item.completion_evidence_sha256 = COALESCE(?, item.completion_evidence_sha256),
          item.last_error = NULL,
          item.updated_at = ?
      WHERE item.cleanup_id = ? AND item.phase = ?
        AND run.run_id = ? AND run.lease_owner = ? AND run.fence = ?
        AND run.state = 'running' AND run.lease_expires_at > ?
    `,
      [
        next,
        (options.expectedBoardMediaVersion ?? item.expectedBoardMediaVersion).toString(),
        (options.expectedObjectVersion ?? item.expectedObjectVersion).toString(),
        options.ownershipQuarantinedAt ?? null,
        options.objectQuarantinedAt ?? null,
        options.deleteAfterExpression ? 1 : 0,
        nowSql,
        options.completionEvidence ?? null,
        nowSql,
        item.cleanupId.toString(),
        item.phase,
        lease.runId,
        lease.leaseOwner,
        lease.fence.toString(),
        nowSql,
      ],
    );
    if (updated.affectedRows !== 1) throw new BoardPersistenceError('row_integrity');
    return next;
  }

  private async databaseNow(connection: PoolConnection): Promise<string> {
    const [rows] = await connection.execute<ClockRow[]>('SELECT UTC_TIMESTAMP(3) AS nowSql');
    const nowSql = rows[0]?.nowSql;
    if (nowSql === undefined) throw new BoardPersistenceError('row_integrity');
    return nowSql;
  }
}

export const mediaBackupObjectMatches = (
  expected: { sha256: Buffer; byteLength: number },
  actual: { sha256: Buffer; byteLength: number },
): boolean =>
  expected.byteLength === actual.byteLength && digestEquals(expected.sha256, actual.sha256);
