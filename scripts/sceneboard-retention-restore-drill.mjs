import { createHash, createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';
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
const mediaKeys = ['mediaManifestSha256', 'mediaObjects'];
const receivedKeys = Object.keys(evidence).sort().join(',');
const baseShape = [...exactKeys].sort().join(',');
const mediaShape = [...exactKeys, ...mediaKeys].sort().join(',');
if (receivedKeys !== baseShape && receivedKeys !== mediaShape) {
  throw new Error('restore drill evidence shape is not exact');
}
const hasMediaEvidence = receivedKeys === mediaShape;
const baseEvidence = Object.fromEntries(exactKeys.map((key) => [key, evidence[key]]));
const certifiedAt = new Date(evidence.certifiedAt);
const expiresAt = new Date(evidence.expiresAt);
if (
  !Number.isInteger(evidence.attemptSeq) ||
  evidence.attemptSeq < 1 ||
  typeof evidence.backupOk !== 'boolean' ||
  typeof evidence.restoreOk !== 'boolean' ||
  typeof evidence.projectionOk !== 'boolean' ||
  typeof evidence.integrityOk !== 'boolean' ||
  expiresAt.getTime() - certifiedAt.getTime() !== 30 * 24 * 60 * 60 * 1000
) {
  throw new Error('restore drill sequence or 30-day expiry is invalid');
}
const keySource = process.env.RETENTION_CERTIFICATE_HMAC_KEY;
if (keySource === undefined || Buffer.byteLength(keySource, 'utf8') < 32) {
  throw new Error('RETENTION_CERTIFICATE_HMAC_KEY must contain at least 32 bytes');
}
const canonical = Buffer.from(JSON.stringify({ version: 1, ...baseEvidence }), 'utf8');
const signature = createHmac('sha256', keySource).update(canonical).digest();
const canonicalMediaObjects = hasMediaEvidence
  ? [...evidence.mediaObjects]
      .map((object) => {
        const keys = Object.keys(object).sort().join(',');
        if (
          keys !== 'byteLength,mediaPk,objectVersion,sha256' ||
          !Number.isInteger(object.mediaPk) ||
          object.mediaPk < 1 ||
          !Number.isInteger(object.objectVersion) ||
          object.objectVersion < 1 ||
          !Number.isInteger(object.byteLength) ||
          object.byteLength < 1 ||
          object.byteLength > 10_485_760 ||
          !/^[0-9a-f]{64}$/u.test(object.sha256)
        )
          throw new Error('media backup object shape is invalid');
        return {
          mediaPk: object.mediaPk,
          objectVersion: object.objectVersion,
          sha256: object.sha256,
          byteLength: object.byteLength,
        };
      })
      .sort((left, right) => left.mediaPk - right.mediaPk)
  : [];
if (
  hasMediaEvidence &&
  (!/^[0-9a-f]{64}$/u.test(evidence.mediaManifestSha256) ||
    new Set(canonicalMediaObjects.map(({ mediaPk }) => mediaPk)).size !==
      canonicalMediaObjects.length)
)
  throw new Error('media backup manifest is invalid');
const mediaManifestBytes = Buffer.from(
  JSON.stringify({ version: 1, objects: canonicalMediaObjects }),
  'utf8',
);
if (
  hasMediaEvidence &&
  createHash('sha256').update(mediaManifestBytes).digest('hex') !== evidence.mediaManifestSha256
)
  throw new Error('media backup manifest digest mismatch');
const connection = await mysql.createConnection({
  host: process.env.MYSQL_HOST,
  port: Number(process.env.MYSQL_PORT),
  user: process.env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD,
  database: process.env.MYSQL_DATABASE,
  timezone: 'Z',
});
try {
  await connection.beginTransaction();
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
  if (hasMediaEvidence) {
    if (!/^[A-Za-z0-9_]{1,128}$/u.test(evidence.quarantineSchema))
      throw new Error('quarantine schema is invalid');
    for (const object of canonicalMediaObjects) {
      const [rows] = await connection.execute(
        `SELECT CAST(media_pk AS CHAR) AS mediaPk, CAST(version AS CHAR) AS objectVersion,
                sha256, bytes, byte_length AS byteLength
         FROM \`${evidence.quarantineSchema}\`.media_objects
         WHERE media_pk = ?`,
        [String(object.mediaPk)],
      );
      const restored = rows[0];
      if (
        rows.length !== 1 ||
        restored === undefined ||
        restored.mediaPk !== String(object.mediaPk) ||
        restored.objectVersion !== String(object.objectVersion) ||
        !Buffer.isBuffer(restored.sha256) ||
        !Buffer.isBuffer(restored.bytes) ||
        restored.byteLength !== object.byteLength ||
        restored.bytes.byteLength !== object.byteLength ||
        !timingSafeEqual(restored.sha256, Buffer.from(object.sha256, 'hex')) ||
        !timingSafeEqual(
          createHash('sha256').update(restored.bytes).digest(),
          Buffer.from(object.sha256, 'hex'),
        )
      )
        throw new Error('restored media object verification failed');
    }
    const auditKeySource = process.env.AUDIT_HMAC_KEY_B64;
    if (auditKeySource === undefined || !/^[A-Za-z0-9_-]+$/u.test(auditKeySource))
      throw new Error('AUDIT_HMAC_KEY_B64 is required for media certification');
    const auditKey = Buffer.from(auditKeySource, 'base64url');
    if (auditKey.byteLength < 32 || auditKey.toString('base64url') !== auditKeySource)
      throw new Error('AUDIT_HMAC_KEY_B64 is not canonical');
    const mediaCertificate = Buffer.from(
      JSON.stringify({
        version: 1,
        deploymentId: evidence.deploymentId,
        attemptSeq: String(evidence.attemptSeq),
        sourceBackupSha256: evidence.sourceBackupSha256,
        mediaManifestSha256: evidence.mediaManifestSha256,
        certifiedAt: evidence.certifiedAt,
        expiresAt: evidence.expiresAt,
        backupOk: evidence.backupOk === true,
        restoreOk: evidence.restoreOk === true,
        integrityOk: evidence.integrityOk === true,
      }),
      'utf8',
    );
    const mediaKey = Buffer.from(
      hkdfSync(
        'sha256',
        auditKey,
        Buffer.from('leecat-board/security/v1', 'ascii'),
        Buffer.from('audit-media-backup-certificate/v1', 'ascii'),
        32,
      ),
    );
    const mediaSignature = createHmac('sha256', mediaKey).update(mediaCertificate).digest();
    await connection.execute(
      `INSERT INTO media_backup_certificates (
         deployment_id, attempt_seq, source_backup_sha256, media_manifest_sha256,
         certified_at, expires_at, backup_ok, restore_ok, integrity_ok, signature
       ) VALUES (?, ?, UNHEX(?), UNHEX(?), ?, ?, ?, ?, ?, ?)`,
      [
        evidence.deploymentId,
        evidence.attemptSeq,
        evidence.sourceBackupSha256,
        evidence.mediaManifestSha256,
        evidence.certifiedAt,
        evidence.expiresAt,
        evidence.backupOk,
        evidence.restoreOk,
        evidence.integrityOk,
        mediaSignature,
      ],
    );
    for (const object of canonicalMediaObjects)
      await connection.execute(
        `INSERT INTO media_backup_certificate_objects (
           deployment_id, attempt_seq, media_pk, object_version, sha256, byte_length
         ) VALUES (?, ?, ?, ?, UNHEX(?), ?)`,
        [
          evidence.deploymentId,
          evidence.attemptSeq,
          object.mediaPk,
          object.objectVersion,
          object.sha256,
          object.byteLength,
        ],
      );
  }
  await connection.commit();
  process.stdout.write(
    `${JSON.stringify({ deploymentId: evidence.deploymentId, attemptSeq: evidence.attemptSeq })}\n`,
  );
} finally {
  await connection.rollback().catch(() => undefined);
  await connection.end();
}
