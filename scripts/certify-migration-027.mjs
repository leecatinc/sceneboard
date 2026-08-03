import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import mysql from 'mysql2/promise';
import {
  certificationDatabaseName,
  certificationDatabaseOwnerSha256,
} from './lib/certification/fixture-ownership.mjs';
import { createNpmCertificationEnvironment } from './lib/certification/process-lifecycle.mjs';

const root = resolve(new URL('..', import.meta.url).pathname);
const historicalVersion = '027_d10_revision_export_hold';
const kinds = [
  'published',
  'media',
  'artifact',
  'idempotency',
  'outbox',
  'recovery',
  'restore',
  'export',
];

const attemptId = process.env.SCENEBOARD_CERTIFICATION_ATTEMPT_ID;
const fixtureAttemptId = `${attemptId}.migration`;
const database = certificationDatabaseName(fixtureAttemptId);
const ownerSha256 = certificationDatabaseOwnerSha256(fixtureAttemptId);
if (
  process.env.APP_ENV !== 'test' ||
  process.env.MYSQL_HOST !== '127.0.0.1' ||
  process.env.MYSQL_DATABASE !== database ||
  process.env.SCENEBOARD_CERTIFICATION_DISPOSABLE_DATABASE !== 'true'
) {
  throw new Error('migration certification requires its uniquely named attempt database');
}

const connectionOptions = {
  host: process.env.MYSQL_HOST,
  port: Number(process.env.MYSQL_PORT),
  user: process.env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD,
  database,
};
const serverConnectionOptions = { ...connectionOptions };
delete serverConnectionOptions.database;
const migrationEnvironment = {
  ...createNpmCertificationEnvironment(process.env),
  APP_ENV: 'test',
  NODE_ENV: 'test',
  MYSQL_HOST: process.env.MYSQL_HOST,
  MYSQL_PORT: process.env.MYSQL_PORT,
  MYSQL_USER: process.env.MYSQL_USER,
  MYSQL_PASSWORD: process.env.MYSQL_PASSWORD,
  MYSQL_DATABASE: database,
  SCENEBOARD_CERTIFICATION_DISPOSABLE_DATABASE: 'true',
  SCENEBOARD_CERTIFICATION_ATTEMPT_ID: attemptId,
  SCENEBOARD_CERTIFICATION_DATABASE_PURPOSE: 'migration',
  SCENEBOARD_CERTIFICATION_DATABASE_OWNER_SHA256: ownerSha256,
};
let schemaClaimed = false;
let ownershipMarkerInstalled = false;
const completedScenarios = [];

const registrySource = readFileSync(
  resolve(root, 'sceneboard-be/src/database/migrations/registry.ts'),
  'utf8',
);
const registryVersions = [...registrySource.matchAll(/\bversion: '([^']+)'/gu)].map(
  (match) => match[1],
);
const terminalVersion = registryVersions.at(-1);
if (registryVersions.indexOf(historicalVersion) < 0 || terminalVersion === undefined)
  throw new Error('migration registry does not contain the historical and terminal boundaries');

const runMigration = (script, args = []) => {
  const run = spawnSync(
    'npm',
    ['run', script, '--workspace', 'sceneboard-be', ...(args.length === 0 ? [] : ['--', ...args])],
    {
      cwd: root,
      env: migrationEnvironment,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  if (run.status !== 0) {
    process.stderr.write(run.stderr || run.stdout || `${script} failed\n`);
    throw new Error(`${script} failed`);
  }
  return run.stdout;
};

const recordScenario = (scenario) => {
  if (completedScenarios.includes(scenario))
    throw new Error(`database certification scenario was recorded twice: ${scenario}`);
  completedScenarios.push(scenario);
};

const claimSchema = async () => {
  const connection = await mysql.createConnection(serverConnectionOptions);
  try {
    const [existing] = await connection.execute(
      'SELECT schema_name AS schemaName FROM information_schema.schemata WHERE schema_name = ?',
      [database],
    );
    if (existing.length !== 0) throw new Error('certification database already exists');
    await connection.query(
      `CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`,
    );
    schemaClaimed = true;
  } finally {
    await connection.end();
  }
  const owned = await mysql.createConnection(connectionOptions);
  try {
    await owned.query(
      `CREATE TABLE certification_fixture_owner (
         owner_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
         created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
         PRIMARY KEY (owner_sha256)
       ) ENGINE=InnoDB`,
    );
    await owned.execute('INSERT INTO certification_fixture_owner (owner_sha256) VALUES (?)', [
      ownerSha256,
    ]);
    ownershipMarkerInstalled = true;
  } finally {
    await owned.end();
  }
};

const assertOwnership = async () => {
  const connection = await mysql.createConnection(connectionOptions);
  try {
    const [rows] = await connection.query(
      'SELECT owner_sha256 AS ownerSha256 FROM certification_fixture_owner',
    );
    if (rows.length !== 1 || rows[0].ownerSha256 !== ownerSha256)
      throw new Error('certification database ownership marker mismatch');
  } finally {
    await connection.end();
  }
};

const cleanupSchema = async () => {
  const errors = [];
  if (ownershipMarkerInstalled) {
    try {
      await assertOwnership();
    } catch (error) {
      errors.push(error);
      throw new AggregateError(errors, 'migration certification cleanup ownership check failed');
    }
  }
  let connection;
  try {
    connection = await mysql.createConnection(serverConnectionOptions);
    const [claimed] = await connection.execute(
      'SELECT schema_name AS schemaName FROM information_schema.schemata WHERE schema_name = ?',
      [database],
    );
    if (claimed.length > 1) throw new Error('certification database ownership claim is ambiguous');
    if (claimed.length === 0) return;
    await connection.query(`DROP DATABASE \`${database}\``);
    const [remaining] = await connection.execute(
      'SELECT schema_name AS schemaName FROM information_schema.schemata WHERE schema_name = ?',
      [database],
    );
    if (remaining.length !== 0) throw new Error('certification database cleanup left residue');
  } catch (error) {
    errors.push(error);
  } finally {
    if (connection) {
      try {
        await connection.end();
      } catch (error) {
        errors.push(error);
      }
    }
  }
  if (errors.length > 0) throw new AggregateError(errors, 'migration certification cleanup failed');
};

const verifyProjectionAndKinds = async () => {
  const connection = await mysql.createConnection(connectionOptions);
  try {
    const [columns] = await connection.query(
      `SELECT column_type AS columnType
       FROM information_schema.columns
       WHERE table_schema = DATABASE()
         AND table_name = 'board_revision_holds'
         AND column_name = 'kind'`,
    );
    if (
      columns.length !== 1 ||
      columns[0].columnType !==
        "enum('published','media','artifact','idempotency','outbox','recovery','restore','export')"
    ) {
      throw new Error('migration 027 enum projection mismatch');
    }
    const [checks] = await connection.query(
      `SELECT cc.check_clause AS checkClause
       FROM information_schema.table_constraints tc
       JOIN information_schema.check_constraints cc
         ON cc.constraint_schema = tc.constraint_schema
        AND cc.constraint_name = tc.constraint_name
       WHERE tc.table_schema = DATABASE()
         AND tc.table_name = 'board_revision_holds'
         AND tc.constraint_name = 'chk_revision_holds_kind'
         AND tc.constraint_type = 'CHECK'`,
    );
    const check = String(checks[0]?.checkClause ?? '')
      .toLowerCase()
      .replaceAll('`', '')
      .replaceAll(/\\'/gu, "'")
      .replaceAll(/_(?:utf8mb4|ascii)(?=')/gu, '')
      .replaceAll(/\s+/gu, '');
    if (
      checks.length !== 1 ||
      !check.includes(
        "kindin('published','media','artifact','idempotency','outbox','recovery','restore','export')",
      )
    ) {
      throw new Error('migration 027 CHECK projection mismatch');
    }

    await connection.beginTransaction();
    await connection.execute(
      `INSERT INTO users
         (public_id, email_normalized, email, display_name, email_verified_at,
          password_hash, status)
       VALUES (?, ?, ?, ?, UTC_TIMESTAMP(3), ?, 1)`,
      ['cert_user', 'cert@example.test', 'cert@example.test', 'Certification user', 'x'.repeat(60)],
    );
    const [board] = await connection.execute(
      `INSERT INTO boards
         (public_id, title, owner_user_id, created_by_kind, created_by_principal_id,
          created_by_grant_id, created_at, updated_at)
       VALUES ('cert_board', 'Certification board', LAST_INSERT_ID(), 'U', 'cert_user',
               NULL, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))`,
    );
    const [revision] = await connection.execute(
      `INSERT INTO board_revisions
         (revision_id, board_pk, revision_number, previous_revision_pk, source_revision_pk,
          origin_code, label, scene_schema_version, scene_codec, scene_payload,
          actor_principal_id, actor_grant_id, request_id, idempotency_scope_sha256, created_at)
       VALUES
         (UNHEX('00000000000000000000000000000001'), ?, 1, NULL, NULL,
          'C', 'Certification revision', NULL, NULL, NULL, NULL, NULL, NULL,
          'U', 'cert_user', NULL, 'cert_request', UNHEX(REPEAT('01', 32)), UTC_TIMESTAMP(3))`,
      [board.insertId],
    );
    for (const kind of kinds) {
      await connection.execute(
        `INSERT INTO board_revision_holds
           (board_pk, revision_pk, kind, holder_id, expires_at, released_at)
         VALUES (?, ?, ?, ?, NULL, NULL)`,
        [board.insertId, revision.insertId, kind, `cert_${kind}`],
      );
    }
    const [inserted] = await connection.query(
      `SELECT kind
       FROM board_revision_holds
       WHERE board_pk = ? AND revision_pk = ?
       ORDER BY FIELD(kind, 'published','media','artifact','idempotency','outbox','recovery',
                           'restore','export')`,
      [board.insertId, revision.insertId],
    );
    if (
      inserted.length !== kinds.length ||
      inserted.some((row, index) => row.kind !== kinds[index])
    ) {
      throw new Error('migration 027 all-kind insertion mismatch');
    }
    await connection.rollback();
  } catch (error) {
    await connection.rollback().catch(() => undefined);
    throw error;
  } finally {
    await connection.end();
  }
};

const verifyTerminalRegistry = async () => {
  const connection = await mysql.createConnection(connectionOptions);
  try {
    const [rows] = await connection.query('SELECT version FROM schema_migrations');
    const applied = new Set(rows.map(({ version }) => version));
    if (
      rows.length !== registryVersions.length ||
      registryVersions.some((version) => !applied.has(version))
    ) {
      throw new Error('migration terminal registry projection mismatch');
    }
  } finally {
    await connection.end();
  }
};

const verifyResumableAudit = async () => {
  let connection = await mysql.createConnection(connectionOptions);
  try {
    await connection.query(
      `CREATE TABLE certification_database_boundary_audit (
         sequence_no TINYINT UNSIGNED NOT NULL,
         scenario VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
         owner_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
         PRIMARY KEY (sequence_no),
         UNIQUE KEY uq_certification_database_boundary_scenario (scenario)
       ) ENGINE=InnoDB`,
    );
    for (const [index, scenario] of completedScenarios.entries())
      await connection.execute(
        `INSERT INTO certification_database_boundary_audit
           (sequence_no, scenario, owner_sha256) VALUES (?, ?, ?)`,
        [index + 1, scenario, ownerSha256],
      );
  } finally {
    await connection.end();
  }

  connection = await mysql.createConnection(connectionOptions);
  try {
    const [rows] = await connection.query(
      `SELECT sequence_no AS sequenceNo, scenario, owner_sha256 AS ownerSha256
       FROM certification_database_boundary_audit
       ORDER BY sequence_no ASC`,
    );
    if (
      rows.length !== completedScenarios.length ||
      rows.some(
        (row, index) =>
          row.sequenceNo !== index + 1 ||
          row.scenario !== completedScenarios[index] ||
          row.ownerSha256 !== ownerSha256,
      )
    ) {
      throw new Error('database certification resumable audit mismatch');
    }
  } finally {
    await connection.end();
  }
};

let primaryFailure;
const cleanupFailures = [];
try {
  await claimSchema();
  runMigration('db:migrate:up');
  recordScenario('fresh');
  runMigration('db:migrate:status');
  runMigration('db:migrate:up');
  runMigration('db:migrate:status');
  recordScenario('bounded-restart');
  await assertOwnership();
  await verifyProjectionAndKinds();
  recordScenario('projection');
  await verifyTerminalRegistry();
  recordScenario('terminal-registry');
  await verifyResumableAudit();
  recordScenario('resumable-audit');

  const connection = await mysql.createConnection(connectionOptions);
  try {
    await connection.query('DELETE FROM schema_migrations');
  } finally {
    await connection.end();
  }
  runMigration('db:migrate:adopt', [
    '--version',
    terminalVersion,
    '--incident-ref',
    'I53-SYNTHETIC-CERTIFICATION',
  ]);
  runMigration('db:migrate:status');
  await verifyTerminalRegistry();
  recordScenario('adopt');
} catch (error) {
  primaryFailure = error;
} finally {
  try {
    if (schemaClaimed) await cleanupSchema();
  } catch (cleanupError) {
    cleanupFailures.push(cleanupError);
  }
}
if (primaryFailure !== undefined || cleanupFailures.length > 0)
  throw new AggregateError(
    [primaryFailure, ...cleanupFailures].filter(Boolean),
    'migration certification or cleanup failed',
  );
recordScenario('zero-residue-cleanup');
const expectedScenarios = [
  'fresh',
  'bounded-restart',
  'projection',
  'terminal-registry',
  'resumable-audit',
  'adopt',
  'zero-residue-cleanup',
];
if (JSON.stringify(completedScenarios) !== JSON.stringify(expectedScenarios))
  throw new Error('database certification scenario closure mismatch');
process.stdout.write(
  `${JSON.stringify({
    schemaVersion: 1,
    status: 'PASS',
    target: 'disposable-loopback-mysql',
    databaseOwnerSha256: ownerSha256,
    terminalVersion,
    scenarios: completedScenarios,
    cleanupStatus: 'PASS',
  })}\n`,
);
