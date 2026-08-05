import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import { buildMigrationConnectionProfile } from '../../src/database/migrations/certification-state.js';
import { createMysqlPoolOptions, MysqlService } from '../../src/database/mysql.service.js';
import { DatabaseOperationAbortedError, withTransaction } from '../../src/database/transaction.js';
import { parseEnvironment } from '../../src/config/env.schema.js';

// Production deadline timers are intentionally unref'ed. Keep this isolated fake-connection
// suite alive long enough for those timers without relying on unrelated test workers.
const deadlineTestKeepAlive = setInterval(() => undefined, 1_000);
after(() => clearInterval(deadlineTestKeepAlive));

const key = 'A'.repeat(43);
const environment = parseEnvironment({
  APP_ENV: 'test',
  NODE_ENV: 'test',
  PORT: '3411',
  MYSQL_HOST: '127.0.0.1',
  MYSQL_PORT: '3306',
  MYSQL_USER: 'sceneboard',
  MYSQL_PASSWORD: 'secret',
  MYSQL_DATABASE: 'sceneboard',
  REDIS_HOST: '127.0.0.1',
  REDIS_PORT: '6379',
  REDIS_PASSWORD: 'secret',
  REDIS_DB: '0',
  REDIS_KEY_PREFIX: 'sceneboard:',
  SCENEBOARD_GMAIL_USER: 'sceneboard@example.com',
  SCENEBOARD_GMAIL_APP_PASSWORD: 'test-app-password',
  SESSION_TOKEN_KEY_B64: key,
  GRANT_TOKEN_KEY_B64: key,
  CSRF_KEY_B64: key,
  PAIRING_CODE_PEPPER_B64: key,
  AUDIT_HMAC_KEY_B64: key,
  RATE_LIMIT_HMAC_KEY_B64: key,
  BOARD_CURSOR_MAC_KEY_B64: key,
  BOARD_STREAM_KEY_B64: Buffer.alloc(32, 9).toString('base64'),
  BCRYPT_COST: '12',
  AUTH_FAILURE_MIN_MS: '500',
  AUTH_FAILURE_JITTER_MS: '20',
  PAIRING_FAILURE_MIN_MS: '100',
  PAIRING_FAILURE_JITTER_MS: '20',
  BOARD_ALLOWED_ORIGINS: 'http://127.0.0.1:3410',
  BOARD_PUBLIC_API_ORIGIN: 'http://127.0.0.1:3411',
  TRUSTED_PROXY_CIDRS: '',
});

test('pins mysql2 safety options and never enables multi-statements', () => {
  const options = createMysqlPoolOptions(environment);
  assert.equal(options.charset, 'utf8mb4');
  assert.equal(options.timezone, 'Z');
  assert.equal(options.dateStrings, true);
  assert.equal(options.supportBigNumbers, true);
  assert.equal(options.bigNumberStrings, true);
  assert.equal(options.multipleStatements, false);
  assert.deepEqual(options.flags, ['-FOUND_ROWS']);
});

test('creates only the non-secret exact migration connection profile', () => {
  const profile = buildMigrationConnectionProfile({
    databaseIdentity: '127.0.0.1:3306/sceneboard/sceneboard',
    serverVersion: '8.0.44',
    timeZone: '+00:00',
    characterSet: 'utf8mb4',
    collation: 'utf8mb4_0900_ai_ci',
    sqlMode: 'ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION,STRICT_TRANS_TABLES',
  });
  assert.match(profile.databaseIdentitySha256, /^[a-f0-9]{64}$/);
  assert.match(profile.sqlModeSha256, /^[a-f0-9]{64}$/);
  assert.equal('password' in profile, false);
  assert.equal(profile.timeZone, '+00:00');
});

const mysqlWithPool = (pool: { getConnection(): Promise<unknown> }): MysqlService => {
  const service = Object.create(MysqlService.prototype) as MysqlService;
  Object.defineProperty(service, 'pool', { value: pool });
  return service;
};

const configuredQuery = async (sql: string): Promise<readonly [unknown, unknown]> => {
  if (sql.includes('SELECT @@session.sql_mode'))
    return [
      [
        {
          sqlMode: 'ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION,STRICT_TRANS_TABLES',
        },
      ],
      [],
    ];
  return [[], []];
};

const withoutUnhandledRejections = async (operation: () => Promise<void>): Promise<void> => {
  const unhandled: unknown[] = [];
  const handler = (reason: unknown): void => {
    unhandled.push(reason);
  };
  process.on('unhandledRejection', handler);
  try {
    await operation();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', handler);
  }
};

test('destroys a connection whose session setup outlives its owned deadline', async () => {
  let destroys = 0;
  let releases = 0;
  const connection = {
    query: () => new Promise<never>(() => undefined),
    release() {
      releases += 1;
    },
    destroy() {
      destroys += 1;
    },
  };
  const mysql = mysqlWithPool({
    async getConnection() {
      return connection;
    },
  });
  await assert.rejects(
    mysql.withConnection(async () => undefined, {
      signal: new AbortController().signal,
      deadlineMs: Date.now() + 20,
      cleanupGraceMs: 20,
    }),
    (error: unknown) => error instanceof DatabaseOperationAbortedError,
  );
  assert.equal(destroys, 1);
  assert.equal(releases, 0);
});

test('destroys a connection whose operation body outlives ownership and observes a late rejection', async () => {
  await withoutUnhandledRejections(async () => {
    const events: string[] = [];
    let rejectLateOperation: ((error: Error) => void) | undefined;
    const poisoned = {
      query: configuredQuery,
      release() {
        events.push('first:release');
      },
      destroy() {
        events.push('first:destroy');
      },
    };
    const healthy = {
      query: configuredQuery,
      release() {
        events.push('second:release');
      },
      destroy() {
        events.push('second:destroy');
      },
    };
    let acquisition = 0;
    const mysql = mysqlWithPool({
      async getConnection() {
        acquisition += 1;
        return acquisition === 1 ? poisoned : healthy;
      },
    });
    const startedAt = Date.now();
    await assert.rejects(
      mysql.withConnection(
        () =>
          new Promise<never>((_resolve, reject) => {
            rejectLateOperation = reject;
          }),
        {
          signal: new AbortController().signal,
          deadlineMs: Date.now() + 20,
          cleanupGraceMs: 20,
        },
      ),
      (error: unknown) => error instanceof DatabaseOperationAbortedError,
    );
    assert.ok(Date.now() - startedAt < 500);
    assert.deepEqual(events, ['first:destroy']);
    rejectLateOperation?.(new Error('fixture late operation rejection'));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(await mysql.withConnection(async () => 'available'), 'available');
    assert.deepEqual(events, ['first:destroy', 'second:release']);
  });
});

test('bounds rollback of timed-out transaction work and allows a subsequent pool acquisition', async () => {
  const events: string[] = [];
  const poisoned = {
    query: configuredQuery,
    async beginTransaction() {
      events.push('first:begin');
    },
    async commit() {
      events.push('first:commit');
    },
    rollback: () => new Promise<never>(() => undefined),
    release() {
      events.push('first:release');
    },
    destroy() {
      events.push('first:destroy');
    },
  };
  const healthy = {
    query: configuredQuery,
    release() {
      events.push('second:release');
    },
    destroy() {
      events.push('second:destroy');
    },
  };
  let acquisition = 0;
  const mysql = mysqlWithPool({
    async getConnection() {
      acquisition += 1;
      return acquisition === 1 ? poisoned : healthy;
    },
  });
  const ownership = {
    signal: new AbortController().signal,
    deadlineMs: Date.now() + 20,
    cleanupGraceMs: 20,
  };
  await assert.rejects(
    mysql.withConnection(
      (connection) =>
        withTransaction(
          connection,
          'REPEATABLE READ',
          () => new Promise<never>(() => undefined),
          ownership,
        ),
      ownership,
    ),
    (error: unknown) => error instanceof DatabaseOperationAbortedError,
  );
  assert.equal(await mysql.withConnection(async () => 'available'), 'available');
  assert.deepEqual(events, ['first:begin', 'first:destroy', 'second:release']);
});

test('does not expose a timed-out transaction commit as a healthy pooled connection', async () => {
  const events: string[] = [];
  const connection = {
    query: configuredQuery,
    async beginTransaction() {
      events.push('begin');
    },
    commit: () => new Promise<never>(() => undefined),
    async rollback() {
      events.push('rollback');
    },
    release() {
      events.push('release');
    },
    destroy() {
      events.push('destroy');
    },
  };
  const mysql = mysqlWithPool({
    async getConnection() {
      return connection;
    },
  });
  const ownership = {
    signal: new AbortController().signal,
    deadlineMs: Date.now() + 20,
    cleanupGraceMs: 20,
  };
  await assert.rejects(
    mysql.withConnection(
      (ownedConnection) =>
        withTransaction(ownedConnection, 'REPEATABLE READ', async () => 'done', ownership),
      ownership,
    ),
    (error: unknown) => error instanceof DatabaseOperationAbortedError,
  );
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(events, ['begin', 'destroy', 'rollback']);
});
