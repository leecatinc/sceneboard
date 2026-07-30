import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

import mysql from 'mysql2/promise';

const root = resolve(new URL('..', import.meta.url).pathname);
const version = '027_d10_revision_export_hold';
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

if (
  process.env.APP_ENV !== 'test' ||
  process.env.MYSQL_HOST !== '127.0.0.1' ||
  process.env.MYSQL_DATABASE !== 'sceneboard' ||
  process.env.SCENEBOARD_CERTIFICATION_DISPOSABLE_DATABASE !== 'true'
) {
  throw new Error('migration certification requires an explicitly disposable loopback database');
}

const connectionOptions = {
  host: process.env.MYSQL_HOST,
  port: Number(process.env.MYSQL_PORT),
  user: process.env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD,
  database: process.env.MYSQL_DATABASE,
};

const runMigration = (script, args = []) => {
  const run = spawnSync(
    'npm',
    ['run', script, '--workspace', 'sceneboard-be', ...(args.length === 0 ? [] : ['--', ...args])],
    {
      cwd: root,
      env: process.env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  if (run.status !== 0) {
    process.stderr.write(run.stderr || run.stdout || `${script} failed\n`);
    throw new Error(`${script} failed`);
  }
};

const resetSchema = async () => {
  const connection = await mysql.createConnection(connectionOptions);
  try {
    const [rows] = await connection.query(
      'SELECT table_name AS tableName FROM information_schema.tables WHERE table_schema = DATABASE()',
    );
    await connection.query('SET FOREIGN_KEY_CHECKS = 0');
    for (const { tableName } of rows) {
      if (!/^[a-z0-9_]+$/u.test(tableName)) throw new Error('unsafe certification table name');
      await connection.query(`DROP TABLE \`${tableName}\``);
    }
    await connection.query('SET FOREIGN_KEY_CHECKS = 1');
  } finally {
    await connection.end();
  }
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
          scene_canonical_bytes, scene_stored_bytes, scene_sha256, actor_kind,
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

await resetSchema();
runMigration('db:migrate:up');
runMigration('db:migrate:status');
await verifyProjectionAndKinds();

const connection = await mysql.createConnection(connectionOptions);
try {
  await connection.query('DELETE FROM schema_migrations');
} finally {
  await connection.end();
}
runMigration('db:migrate:adopt', [
  '--version',
  version,
  '--incident-ref',
  'I53-SYNTHETIC-CERTIFICATION',
]);
runMigration('db:migrate:status');

process.stdout.write('migration 027 fresh, restart, adopt, and all-kind certification passed\n');
