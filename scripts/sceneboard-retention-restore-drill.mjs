import { createHash, createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import process from 'node:process';

import mysql from 'mysql2/promise';

const attemptPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const canonicalJson = (value) => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(',')}}`;
};
const schemaName = (attemptId, purpose) =>
  `sceneboard_cert_${sha256(`${attemptId}.restore.${purpose}`).slice(0, 20)}`;
const ownerSha256 = (attemptId, purpose) =>
  sha256(`sceneboard-certification-restore:${attemptId}:${purpose}`);
const quoteIdentifier = (value) => {
  if (!/^sceneboard_cert_[0-9a-f]{20}$/u.test(value))
    throw new Error('restore certification schema identity is invalid');
  return `\`${value}\``;
};

if (process.argv.length !== 3 || process.argv[2] !== '--produce') {
  throw new Error('usage: sceneboard-retention-restore-drill.mjs --produce');
}

const attemptId = process.env.SCENEBOARD_CERTIFICATION_ATTEMPT_ID;
if (
  !attemptPattern.test(attemptId ?? '') ||
  process.env.APP_ENV !== 'test' ||
  process.env.NODE_ENV !== 'test' ||
  process.env.MYSQL_HOST !== '127.0.0.1' ||
  process.env.SCENEBOARD_CERTIFICATION_RESTORE_FIXTURES_DISPOSABLE !== 'true'
) {
  throw new Error('restore certification requires an exact test-only loopback identity');
}
const keySource = process.env.RETENTION_CERTIFICATE_HMAC_KEY;
if (keySource === undefined || Buffer.byteLength(keySource, 'utf8') < 32)
  throw new Error('RETENTION_CERTIFICATE_HMAC_KEY must contain at least 32 bytes');
const auditKeySource = process.env.AUDIT_HMAC_KEY_B64;
if (auditKeySource === undefined || !/^[A-Za-z0-9_-]+$/u.test(auditKeySource))
  throw new Error('AUDIT_HMAC_KEY_B64 is required for restore certification');
const auditKey = Buffer.from(auditKeySource, 'base64url');
if (auditKey.byteLength < 32 || auditKey.toString('base64url') !== auditKeySource)
  throw new Error('AUDIT_HMAC_KEY_B64 is not canonical');

const sourceSchema = schemaName(attemptId, 'source');
const quarantineSchema = schemaName(attemptId, 'quarantine');
const sourceOwnerSha256 = ownerSha256(attemptId, 'source');
const quarantineOwnerSha256 = ownerSha256(attemptId, 'quarantine');
const sourceSchemaSql = quoteIdentifier(sourceSchema);
const quarantineSchemaSql = quoteIdentifier(quarantineSchema);
const mainDatabase = process.env.MYSQL_DATABASE;
const registrySha256 = sha256(
  readFileSync(new URL('../sceneboard-be/src/database/migrations/registry.ts', import.meta.url)),
);
if (
  !/^[A-Za-z0-9_]{1,128}$/u.test(mainDatabase ?? '') ||
  [sourceSchema, quarantineSchema].includes(mainDatabase)
) {
  throw new Error('restore certification target database is invalid');
}

const serverOptions = {
  host: process.env.MYSQL_HOST,
  port: Number(process.env.MYSQL_PORT),
  user: process.env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD,
  timezone: 'Z',
};
const createdSchemas = [];
const cleanupErrors = [];

const assertSchemaAbsent = async (connection, schema) => {
  const [rows] = await connection.execute(
    'SELECT schema_name FROM information_schema.schemata WHERE schema_name = ?',
    [schema],
  );
  if (rows.length !== 0) throw new Error('restore certification schema already exists');
};

const createOwnedSchema = async (connection, schema, schemaSql, expectedOwnerSha256) => {
  await assertSchemaAbsent(connection, schema);
  await connection.query(
    `CREATE DATABASE ${schemaSql} CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`,
  );
  createdSchemas.push({ schema, schemaSql, expectedOwnerSha256 });
  await connection.query(
    `CREATE TABLE ${schemaSql}.certification_fixture_owner (
       owner_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
       created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
       PRIMARY KEY (owner_sha256)
     ) ENGINE=InnoDB`,
  );
  await connection.execute(
    `INSERT INTO ${schemaSql}.certification_fixture_owner (owner_sha256) VALUES (?)`,
    [expectedOwnerSha256],
  );
};

const assertOwnership = async (connection, { schemaSql, expectedOwnerSha256 }) => {
  const [rows] = await connection.query(
    `SELECT owner_sha256 AS ownerSha256 FROM ${schemaSql}.certification_fixture_owner`,
  );
  if (rows.length !== 1 || rows[0].ownerSha256 !== expectedOwnerSha256)
    throw new Error('restore certification schema owner mismatch');
};

const projectionFor = async (connection, schema) => {
  const [columns] = await connection.execute(
    `SELECT column_name AS columnName, ordinal_position AS ordinalPosition,
            column_type AS columnType, is_nullable AS isNullable
     FROM information_schema.columns
     WHERE table_schema = ? AND table_name = 'media_objects'
     ORDER BY ordinal_position ASC`,
    [schema],
  );
  return columns;
};

const fixtureBytes = Buffer.from(
  canonicalJson({
    schemaVersion: 1,
    attemptSha256: sha256(attemptId),
    marker: 'restore-live-fixture',
  }),
  'utf8',
);
const mediaSha256 = sha256(fixtureBytes);
const startedAt = new Date();
let report;
let primaryFailure;

const server = await mysql.createConnection(serverOptions);
try {
  const [operatorRows] = await server.query('SELECT CURRENT_USER() AS currentUser');
  const operatorPrincipal = String(operatorRows[0]?.currentUser ?? '');
  if (operatorPrincipal === '' || /^root@/u.test(operatorPrincipal))
    throw new Error('restore certification requires a restricted database operator');

  await createOwnedSchema(server, sourceSchema, sourceSchemaSql, sourceOwnerSha256);
  await server.query(
    `CREATE TABLE ${sourceSchemaSql}.media_objects (
       media_pk BIGINT UNSIGNED NOT NULL,
       version BIGINT UNSIGNED NOT NULL,
       sha256 BINARY(32) NOT NULL,
       bytes LONGBLOB NOT NULL,
       byte_length INT UNSIGNED NOT NULL,
       PRIMARY KEY (media_pk),
       CONSTRAINT chk_restore_media_length CHECK (byte_length = OCTET_LENGTH(bytes))
     ) ENGINE=InnoDB`,
  );
  await server.execute(
    `INSERT INTO ${sourceSchemaSql}.media_objects
       (media_pk, version, sha256, bytes, byte_length) VALUES (1, 1, UNHEX(?), ?, ?)`,
    [mediaSha256, fixtureBytes, fixtureBytes.length],
  );
  await assertOwnership(server, createdSchemas[0]);
  const sourceProjection = await projectionFor(server, sourceSchema);
  const [sourceRows] = await server.query(
    `SELECT CAST(media_pk AS CHAR) AS mediaPk, CAST(version AS CHAR) AS objectVersion,
            LOWER(HEX(sha256)) AS sha256, bytes, byte_length AS byteLength
     FROM ${sourceSchemaSql}.media_objects ORDER BY media_pk ASC`,
  );
  const backup = {
    schemaVersion: 1,
    sourceOwnerSha256,
    projection: sourceProjection,
    objects: sourceRows.map((row) => ({
      mediaPk: row.mediaPk,
      objectVersion: row.objectVersion,
      sha256: row.sha256,
      byteLength: row.byteLength,
      bytesBase64: row.bytes.toString('base64'),
    })),
  };
  const backupBytes = Buffer.from(canonicalJson(backup), 'utf8');
  const sourceBackupSha256 = sha256(backupBytes);

  await createOwnedSchema(server, quarantineSchema, quarantineSchemaSql, quarantineOwnerSha256);
  await server.query(
    `CREATE TABLE ${quarantineSchemaSql}.media_objects LIKE ${sourceSchemaSql}.media_objects`,
  );
  for (const object of backup.objects)
    await server.execute(
      `INSERT INTO ${quarantineSchemaSql}.media_objects
         (media_pk, version, sha256, bytes, byte_length) VALUES (?, ?, UNHEX(?), ?, ?)`,
      [
        object.mediaPk,
        object.objectVersion,
        object.sha256,
        Buffer.from(object.bytesBase64, 'base64'),
        object.byteLength,
      ],
    );
  await assertOwnership(server, createdSchemas[1]);
  const quarantineProjection = await projectionFor(server, quarantineSchema);
  const schemaProjectionSha256 = sha256(canonicalJson(sourceProjection));
  if (
    canonicalJson(quarantineProjection) !== canonicalJson(sourceProjection) ||
    sha256(canonicalJson(quarantineProjection)) !== schemaProjectionSha256
  ) {
    throw new Error('restored schema projection mismatch');
  }
  const [restoredRows] = await server.query(
    `SELECT CAST(media_pk AS CHAR) AS mediaPk, CAST(version AS CHAR) AS objectVersion,
            sha256, bytes, byte_length AS byteLength
     FROM ${quarantineSchemaSql}.media_objects ORDER BY media_pk ASC`,
  );
  if (
    restoredRows.length !== 1 ||
    restoredRows[0].mediaPk !== '1' ||
    restoredRows[0].objectVersion !== '1' ||
    restoredRows[0].byteLength !== fixtureBytes.length ||
    !timingSafeEqual(restoredRows[0].sha256, Buffer.from(mediaSha256, 'hex')) ||
    !timingSafeEqual(restoredRows[0].bytes, fixtureBytes)
  ) {
    throw new Error('restored media byte integrity mismatch');
  }
  const mediaManifest = {
    schemaVersion: 1,
    objects: [
      { mediaPk: '1', objectVersion: '1', sha256: mediaSha256, byteLength: fixtureBytes.length },
    ],
  };
  const mediaManifestSha256 = sha256(canonicalJson(mediaManifest));
  const integritySha256 = sha256(
    canonicalJson({
      sourceBackupSha256,
      mediaManifestSha256,
      schemaProjectionSha256,
      quarantineOwnerSha256,
      operatorPrincipal,
    }),
  );
  const restoredAt = new Date();

  for (const owned of [...createdSchemas].reverse()) {
    await assertOwnership(server, owned);
    await server.query(`DROP DATABASE ${owned.schemaSql}`);
    await assertSchemaAbsent(server, owned.schema);
    createdSchemas.splice(createdSchemas.indexOf(owned), 1);
  }

  const certifiedAt = new Date();
  const expiresAt = new Date(certifiedAt.getTime() + 30 * 24 * 60 * 60 * 1_000);
  const deploymentId = `cert-${sha256(attemptId).slice(0, 24)}`;
  const evidence = {
    schemaVersion: 2,
    attemptId,
    deploymentId,
    attemptSeq: 1,
    sourceSchemaSha256: sha256(sourceSchema),
    sourceOwnerSha256,
    quarantineSchemaSha256: sha256(quarantineSchema),
    quarantineOwnerSha256,
    operatorPrincipalSha256: sha256(operatorPrincipal),
    startedAt: startedAt.toISOString(),
    restoredAt: restoredAt.toISOString(),
    certifiedAt: certifiedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    sourceBackupSha256,
    registrySha256,
    mediaManifestSha256,
    schemaProjectionSha256,
    integritySha256,
    cleanupStatus: 'PASS',
  };
  const evidenceSha256 = sha256(canonicalJson(evidence));
  const signature = createHmac('sha256', keySource)
    .update(Buffer.from(canonicalJson(evidence), 'utf8'))
    .digest();
  const mediaKey = Buffer.from(
    hkdfSync(
      'sha256',
      auditKey,
      Buffer.from('leecat-board/security/v1', 'ascii'),
      Buffer.from('audit-media-backup-certificate/v1', 'ascii'),
      32,
    ),
  );
  const mediaCertificate = Buffer.from(
    canonicalJson({
      schemaVersion: 1,
      deploymentId,
      attemptSeq: '1',
      sourceBackupSha256,
      mediaManifestSha256,
      certifiedAt: certifiedAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      backupOk: true,
      restoreOk: true,
      integrityOk: true,
    }),
    'utf8',
  );
  const mediaSignature = createHmac('sha256', mediaKey).update(mediaCertificate).digest();
  const main = await mysql.createConnection({ ...serverOptions, database: mainDatabase });
  try {
    await main.beginTransaction();
    await main.execute(
      `INSERT INTO retention_restore_drill_attempts (
         deployment_id, attempt_seq, registry_digest, schema_projection_sha256,
         source_backup_sha256, isolation_id, quarantine_schema, operator_principal,
         started_at, restored_at, certified_at, expires_at,
         backup_ok, restore_ok, projection_ok, integrity_ok, evidence_sha256, signature
       ) VALUES (?, ?, UNHEX(?), UNHEX(?), UNHEX(?), ?, ?, ?, ?, ?, ?, ?, TRUE, TRUE, TRUE, TRUE, UNHEX(?), ?)`,
      [
        deploymentId,
        1,
        registrySha256,
        schemaProjectionSha256,
        sourceBackupSha256,
        attemptId,
        quarantineSchema,
        operatorPrincipal,
        startedAt,
        restoredAt,
        certifiedAt,
        expiresAt,
        evidenceSha256,
        signature,
      ],
    );
    await main.execute(
      `INSERT INTO media_backup_certificates (
         deployment_id, attempt_seq, source_backup_sha256, media_manifest_sha256,
         certified_at, expires_at, backup_ok, restore_ok, integrity_ok, signature
       ) VALUES (?, ?, UNHEX(?), UNHEX(?), ?, ?, TRUE, TRUE, TRUE, ?)`,
      [
        deploymentId,
        1,
        sourceBackupSha256,
        mediaManifestSha256,
        certifiedAt,
        expiresAt,
        mediaSignature,
      ],
    );
    await main.execute(
      `INSERT INTO media_backup_certificate_objects (
         deployment_id, attempt_seq, media_pk, object_version, sha256, byte_length
       ) VALUES (?, ?, 1, 1, UNHEX(?), ?)`,
      [deploymentId, 1, mediaSha256, fixtureBytes.length],
    );
    await main.commit();
  } catch (error) {
    await main.rollback().catch(() => undefined);
    throw error;
  } finally {
    await main.end();
  }
  report = { ...evidence, evidenceSha256, status: 'PASS' };
} catch (error) {
  primaryFailure = error;
} finally {
  for (const owned of [...createdSchemas].reverse()) {
    try {
      await assertOwnership(server, owned);
      await server.query(`DROP DATABASE ${owned.schemaSql}`);
      await assertSchemaAbsent(server, owned.schema);
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  await server.end().catch((error) => cleanupErrors.push(error));
}

if (primaryFailure !== undefined || cleanupErrors.length > 0)
  throw new AggregateError(
    [primaryFailure, ...cleanupErrors].filter(Boolean),
    'restore certification or zero-residue cleanup failed',
  );
process.stdout.write(`${canonicalJson(report)}\n`);
