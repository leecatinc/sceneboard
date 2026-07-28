import { createHmac, timingSafeEqual } from 'node:crypto';

import type { PoolConnection, RowDataPacket } from 'mysql2/promise';

interface RestoreDrillRow extends RowDataPacket {
  deploymentId: string;
  attemptSeq: string;
  registryDigestHex: string;
  schemaProjectionSha256Hex: string;
  sourceBackupSha256Hex: string;
  isolationId: string;
  quarantineSchema: string;
  operatorPrincipal: string;
  startedAt: string;
  restoredAt: string | null;
  certifiedAt: string;
  expiresAt: string;
  backupOk: number;
  restoreOk: number;
  projectionOk: number;
  integrityOk: number;
  evidenceSha256Hex: string;
  signature: Buffer;
  unexpired: number;
}

export interface RetentionEnablementExpectationV1 {
  deploymentId: string;
  registryDigestHex: string;
  schemaProjectionSha256Hex: string;
  parityCertified: boolean;
  detachedReadFlip: boolean;
  detachedOnlyWriter: boolean;
  oldBinaryRejected: boolean;
  anchorZeroBytesCertified: boolean;
}

const canonicalCertificate = (row: RestoreDrillRow): Buffer =>
  Buffer.from(
    JSON.stringify({
      version: 1,
      deploymentId: row.deploymentId,
      attemptSeq: row.attemptSeq,
      registryDigest: row.registryDigestHex,
      schemaProjectionSha256: row.schemaProjectionSha256Hex,
      sourceBackupSha256: row.sourceBackupSha256Hex,
      isolationId: row.isolationId,
      quarantineSchema: row.quarantineSchema,
      operatorPrincipal: row.operatorPrincipal,
      startedAt: row.startedAt,
      restoredAt: row.restoredAt,
      certifiedAt: row.certifiedAt,
      expiresAt: row.expiresAt,
      backupOk: row.backupOk === 1,
      restoreOk: row.restoreOk === 1,
      projectionOk: row.projectionOk === 1,
      integrityOk: row.integrityOk === 1,
      evidenceSha256: row.evidenceSha256Hex,
    }),
    'utf8',
  );

export class RetentionEnablementService {
  constructor(private readonly certificateHmacKey: Uint8Array) {
    if (certificateHmacKey.byteLength < 32) {
      throw new TypeError('retention certificate HMAC key must contain at least 32 bytes');
    }
  }

  async isEnabled(
    connection: PoolConnection,
    expectation: RetentionEnablementExpectationV1,
  ): Promise<boolean> {
    if (
      !expectation.parityCertified ||
      !expectation.detachedReadFlip ||
      !expectation.detachedOnlyWriter ||
      !expectation.oldBinaryRejected ||
      !expectation.anchorZeroBytesCertified
    ) {
      return false;
    }
    const [rows] = await connection.execute<RestoreDrillRow[]>(
      `
      SELECT deployment_id AS deploymentId, CAST(attempt_seq AS CHAR) AS attemptSeq,
             LOWER(HEX(registry_digest)) AS registryDigestHex,
             LOWER(HEX(schema_projection_sha256)) AS schemaProjectionSha256Hex,
             LOWER(HEX(source_backup_sha256)) AS sourceBackupSha256Hex,
             isolation_id AS isolationId, quarantine_schema AS quarantineSchema,
             operator_principal AS operatorPrincipal,
             DATE_FORMAT(started_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS startedAt,
             DATE_FORMAT(restored_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS restoredAt,
             DATE_FORMAT(certified_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS certifiedAt,
             DATE_FORMAT(expires_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS expiresAt,
             backup_ok AS backupOk, restore_ok AS restoreOk,
             projection_ok AS projectionOk, integrity_ok AS integrityOk,
             LOWER(HEX(evidence_sha256)) AS evidenceSha256Hex,
             signature,
             expires_at > CURRENT_TIMESTAMP(3) AS unexpired
      FROM retention_restore_drill_attempts
      WHERE deployment_id = ?
      ORDER BY attempt_seq DESC
      LIMIT 1
    `,
      [expectation.deploymentId],
    );
    const row = rows[0];
    if (
      rows.length !== 1 ||
      row === undefined ||
      row.unexpired !== 1 ||
      row.backupOk !== 1 ||
      row.restoreOk !== 1 ||
      row.projectionOk !== 1 ||
      row.integrityOk !== 1 ||
      row.registryDigestHex !== expectation.registryDigestHex ||
      row.schemaProjectionSha256Hex !== expectation.schemaProjectionSha256Hex ||
      row.signature.byteLength !== 32
    ) {
      return false;
    }
    const expected = createHmac('sha256', this.certificateHmacKey)
      .update(canonicalCertificate(row))
      .digest();
    return timingSafeEqual(row.signature, expected);
  }
}
