import { createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import process from 'node:process';

import mysql from 'mysql2/promise';

const evidencePath = process.argv[2];
if (evidencePath === undefined) {
  throw new Error('usage: sceneboard-retention-restore-drill.mjs <evidence.json>');
}
const evidence = JSON.parse(await readFile(evidencePath, 'utf8'));
const exactKeys = [
  'deploymentId',
  'attemptSeq',
  'registryDigest',
  'schemaProjectionSha256',
  'sourceBackupSha256',
  'isolationId',
  'quarantineSchema',
  'operatorPrincipal',
  'startedAt',
  'restoredAt',
  'certifiedAt',
  'expiresAt',
  'backupOk',
  'restoreOk',
  'projectionOk',
  'integrityOk',
  'evidenceSha256',
];
if (Object.keys(evidence).sort().join(',') !== [...exactKeys].sort().join(',')) {
  throw new Error('restore drill evidence shape is not exact');
}
const certifiedAt = new Date(evidence.certifiedAt);
const expiresAt = new Date(evidence.expiresAt);
if (
  !Number.isInteger(evidence.attemptSeq) ||
  evidence.attemptSeq < 1 ||
  expiresAt.getTime() - certifiedAt.getTime() !== 30 * 24 * 60 * 60 * 1000
) {
  throw new Error('restore drill sequence or 30-day expiry is invalid');
}
const keySource = process.env.RETENTION_CERTIFICATE_HMAC_KEY;
if (keySource === undefined || Buffer.byteLength(keySource, 'utf8') < 32) {
  throw new Error('RETENTION_CERTIFICATE_HMAC_KEY must contain at least 32 bytes');
}
const canonical = Buffer.from(JSON.stringify({ version: 1, ...evidence }), 'utf8');
const signature = createHmac('sha256', keySource).update(canonical).digest();
const connection = await mysql.createConnection({
  host: process.env.MYSQL_HOST,
  port: Number(process.env.MYSQL_PORT),
  user: process.env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD,
  database: process.env.MYSQL_DATABASE,
  timezone: 'Z',
});
try {
  await connection.execute(
    `INSERT INTO retention_restore_drill_attempts (
       deployment_id, attempt_seq, registry_digest, schema_projection_sha256,
       source_backup_sha256, isolation_id, quarantine_schema, operator_principal,
       started_at, restored_at, certified_at, expires_at,
       backup_ok, restore_ok, projection_ok, integrity_ok, evidence_sha256, signature
     ) VALUES (?, ?, UNHEX(?), UNHEX(?), UNHEX(?), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, UNHEX(?), ?)`,
    [
      evidence.deploymentId,
      evidence.attemptSeq,
      evidence.registryDigest,
      evidence.schemaProjectionSha256,
      evidence.sourceBackupSha256,
      evidence.isolationId,
      evidence.quarantineSchema,
      evidence.operatorPrincipal,
      evidence.startedAt,
      evidence.restoredAt,
      evidence.certifiedAt,
      evidence.expiresAt,
      evidence.backupOk,
      evidence.restoreOk,
      evidence.projectionOk,
      evidence.integrityOk,
      evidence.evidenceSha256,
      signature,
    ],
  );
  process.stdout.write(
    `${JSON.stringify({ deploymentId: evidence.deploymentId, attemptSeq: evidence.attemptSeq })}\n`,
  );
} finally {
  await connection.end();
}
