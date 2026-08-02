import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PoolConnection, RowDataPacket } from 'mysql2/promise';

import type { AuditRepository } from '../../src/audit/audit.repository.js';
import { AccountApiKeyRepository } from '../../src/api-keys/account-api-key.repository.js';
import type { MysqlService } from '../../src/database/mysql.service.js';

const compact = (sql: string): string => sql.replace(/\s+/g, ' ').trim();

const transactionalConnection = (
  execute: (sql: string, values?: unknown) => Promise<unknown>,
): PoolConnection =>
  ({
    async query() {
      return [[], []];
    },
    async execute(sql: string, values?: unknown) {
      return execute(compact(sql), values);
    },
    async beginTransaction() {},
    async commit() {},
    async rollback() {},
  }) as unknown as PoolConnection;

const mysqlWith = (connection: PoolConnection): MysqlService =>
  ({
    async withConnection<Value>(operation: (value: PoolConnection) => Promise<Value>) {
      return operation(connection);
    },
  }) as MysqlService;

test('lists one newest-first keyset page with database-time statuses and a cut boundary', async () => {
  const auditEvents: unknown[] = [];
  const calls: string[] = [];
  const connection = transactionalConnection(async (sql) => {
    calls.push(sql);
    if (sql.includes('FROM users')) {
      return [[{ status: 1, publicId: 'user_public_1' } as RowDataPacket], []];
    }
    if (sql.includes('FROM account_api_keys') && sql.includes('ORDER BY created_at DESC')) {
      return [
        [
          {
            id: '12',
            publicId: 'key_public_12',
            displayName: 'Newest',
            tokenLocator: Buffer.alloc(16, 1),
            scopeMask: 4,
            status: 1,
            expiresAt: '2027-02-02 00:00:00.000',
            createdAt: '2027-02-01 00:00:02.000',
            lastUsedAt: null,
            databaseNow: '2027-02-01 00:00:00.000',
          },
          {
            id: '11',
            publicId: 'key_public_11',
            displayName: 'Expired',
            tokenLocator: Buffer.alloc(16, 2),
            scopeMask: 4,
            status: 1,
            expiresAt: '2027-02-01 00:00:00.000',
            createdAt: '2027-02-01 00:00:01.000',
            lastUsedAt: null,
            databaseNow: '2027-02-01 00:00:00.000',
          },
          {
            id: '10',
            publicId: 'key_public_10',
            displayName: 'Older',
            tokenLocator: Buffer.alloc(16, 3),
            scopeMask: 4,
            status: 2,
            expiresAt: '2027-02-03 00:00:00.000',
            createdAt: '2027-02-01 00:00:00.000',
            lastUsedAt: null,
            databaseNow: '2027-02-01 00:00:00.000',
          },
        ] as RowDataPacket[],
        [],
      ];
    }
    return [[], []];
  });
  const audit = {
    async writeMandatory(_transaction: unknown, input: unknown) {
      auditEvents.push(input);
    },
  } as AuditRepository;
  const repository = new AccountApiKeyRepository(mysqlWith(connection), audit);
  const result = await repository.list({
    ownerUserPk: '1',
    boundary: null,
    limit: 2,
    prefixFromLocator: (locator) => `prefix-${locator[0]}`,
    auditContext: {
      correlationId: 'correlation_1',
      ownerPublicId: 'user_public_1',
      sessionPublicId: 'session_public_1',
      actorPublicId: 'user_public_1',
    },
  });
  assert.equal(result.kind, 'listed');
  if (result.kind !== 'listed') assert.fail('expected a listed result');
  assert.deepEqual(
    result.items.map(({ apiKeyId, status, prefix }) => ({ apiKeyId, status, prefix })),
    [
      { apiKeyId: 'key_public_12', status: 'active', prefix: 'prefix-1' },
      { apiKeyId: 'key_public_11', status: 'expired', prefix: 'prefix-2' },
    ],
  );
  assert.deepEqual(result.nextBoundary, {
    createdAt: '2027-02-01T00:00:01.000Z',
    id: '11',
  });
  assert.equal(auditEvents.length, 1);
  assert.equal(calls[0]?.includes('FROM users'), true);
  assert.equal(calls[0]?.endsWith('FOR UPDATE'), true);
});

test('denies list for missing and disabled owners before key reads, publication, or audit', async () => {
  for (const ownerStatus of [null, 0] as const) {
    const calls: string[] = [];
    let prefixCalls = 0;
    let auditCalls = 0;
    const connection = transactionalConnection(async (sql) => {
      calls.push(sql);
      if (sql.includes('FROM users')) {
        return ownerStatus === null
          ? [[], []]
          : [[{ status: ownerStatus, publicId: 'user_public_1' } as RowDataPacket], []];
      }
      throw new Error(`list denial reached a key query: ${sql}`);
    });
    const repository = new AccountApiKeyRepository(mysqlWith(connection), {
      writeMandatory: async () => {
        auditCalls += 1;
      },
    } as never);

    const result = await repository.list({
      ownerUserPk: '1',
      boundary: null,
      limit: 20,
      prefixFromLocator: () => {
        prefixCalls += 1;
        return 'unexpected';
      },
      auditContext: {
        correlationId: 'correlation_list_denied',
        ownerPublicId: 'user_public_1',
        sessionPublicId: 'session_public_1',
        actorPublicId: 'user_public_1',
      },
    });

    assert.deepEqual(result, { kind: 'owner_disabled' }, String(ownerStatus));
    assert.equal(calls.length, 1, String(ownerStatus));
    assert.equal(calls[0]?.includes('FROM users'), true, String(ownerStatus));
    assert.equal(calls[0]?.endsWith('FOR UPDATE'), true, String(ownerStatus));
    assert.equal(prefixCalls, 0, String(ownerStatus));
    assert.equal(auditCalls, 0, String(ownerStatus));
  }
});

test('enforces the ten-active-key quota while holding the owner row lock', async () => {
  const calls: string[] = [];
  const connection = transactionalConnection(async (sql) => {
    calls.push(sql);
    if (sql.includes('FROM users')) {
      return [[{ status: 1, publicId: 'user_public_1' } as RowDataPacket], []];
    }
    if (sql.includes('UTC_TIMESTAMP(3) AS databaseNow')) {
      return [[{ databaseNow: '2027-02-01 00:00:00.000' } as RowDataPacket], []];
    }
    if (sql.includes('COUNT(*) AS activeCount')) {
      return [
        [
          {
            activeCount: 10,
            earliestActiveExpiry: '2027-02-01 00:00:01.001',
          } as RowDataPacket,
        ],
        [],
      ];
    }
    throw new Error('unexpected query');
  });
  const repository = new AccountApiKeyRepository(mysqlWith(connection), {
    writeMandatory: async () => assert.fail('quota rejection must not audit success'),
  } as never);
  const result = await repository.issue({
    ownerUserPk: '1',
    keyPublicId: 'key_public_1',
    name: 'Automation',
    locator: Buffer.alloc(16, 1),
    tokenHash: Buffer.alloc(32, 2),
    scopeMask: 4,
    expiresInDays: 90,
    prefix: 'sbk_v1.AAAAAAAA…',
    auditContext: {
      correlationId: 'correlation_2',
      ownerPublicId: 'user_public_1',
      sessionPublicId: 'session_public_1',
      actorPublicId: 'user_public_1',
    },
  });
  assert.deepEqual(result, {
    kind: 'quota_exceeded',
    earliestActiveExpiry: Date.parse('2027-02-01T00:00:01.001Z'),
    databaseNow: Date.parse('2027-02-01T00:00:00.000Z'),
  });
  assert.equal(calls[0]?.endsWith('FOR UPDATE'), true);
  assert.equal(
    calls.some((sql) => sql.startsWith('INSERT')),
    false,
  );
});

test('uses one database clock for quota evaluation and persisted issue metadata', async () => {
  const databaseNow = '2027-02-01 00:00:03.000';
  const calls: Array<{ sql: string; values?: unknown }> = [];
  const connection = transactionalConnection(async (sql, values) => {
    calls.push({ sql, values });
    if (sql.includes('FROM users')) {
      return [[{ status: 1, publicId: 'user_public_1' } as RowDataPacket], []];
    }
    if (sql.includes('UTC_TIMESTAMP(3) AS databaseNow')) {
      return [[{ databaseNow } as RowDataPacket], []];
    }
    if (sql.includes('COUNT(*) AS activeCount')) {
      return [[{ activeCount: 9 } as RowDataPacket], []];
    }
    if (sql.startsWith('INSERT INTO account_api_keys')) {
      return [{ affectedRows: 1 }, []];
    }
    throw new Error(`unexpected query: ${sql}`);
  });
  const repository = new AccountApiKeyRepository(mysqlWith(connection), {
    writeMandatory: async () => undefined,
  } as never);
  const result = await repository.issue({
    ownerUserPk: '1',
    keyPublicId: 'key_public_1',
    name: 'Automation',
    locator: Buffer.alloc(16, 1),
    tokenHash: Buffer.alloc(32, 2),
    scopeMask: 4,
    expiresInDays: 90,
    prefix: 'sbk_v1.AAAAAAAA…',
    auditContext: {
      correlationId: 'correlation_2',
      ownerPublicId: 'user_public_1',
      sessionPublicId: 'session_public_1',
      actorPublicId: 'user_public_1',
    },
  });
  assert.equal(result.kind, 'created');
  if (result.kind !== 'created') assert.fail('expected a created result');
  assert.equal(result.metadata.createdAt, '2027-02-01T00:00:03.000Z');
  const quota = calls.find(({ sql }) => sql.includes('COUNT(*) AS activeCount'));
  assert.deepEqual(quota?.values, ['1', databaseNow]);
  const insert = calls.find(({ sql }) => sql.startsWith('INSERT INTO account_api_keys'));
  assert.equal(Array.isArray(insert?.values), true);
  assert.equal((insert?.values as unknown[]).at(-1), databaseNow);
});

test('derives every closed expiry duration from the transaction database clock', async () => {
  const databaseNow = '2027-02-01 00:00:03.000';
  const calls: Array<{ sql: string; values?: unknown }> = [];
  const connection = transactionalConnection(async (sql, values) => {
    calls.push({ sql, values });
    if (sql.includes('FROM users')) {
      return [[{ status: 1, publicId: 'user_public_1' } as RowDataPacket], []];
    }
    if (sql.includes('UTC_TIMESTAMP(3) AS databaseNow')) {
      return [[{ databaseNow } as RowDataPacket], []];
    }
    if (sql.includes('COUNT(*) AS activeCount')) {
      return [[{ activeCount: 0 } as RowDataPacket], []];
    }
    if (sql.startsWith('INSERT INTO account_api_keys')) return [{ affectedRows: 1 }, []];
    throw new Error(`unexpected query: ${sql}`);
  });
  const repository = new AccountApiKeyRepository(mysqlWith(connection), {
    writeMandatory: async () => undefined,
  } as never);
  const base = {
    ownerUserPk: '1',
    keyPublicId: 'key_public_1',
    name: 'Automation',
    locator: Buffer.alloc(16, 1),
    tokenHash: Buffer.alloc(32, 2),
    scopeMask: 4,
    prefix: 'sbk_v1.AAAAAAAA…',
    auditContext: {
      correlationId: 'correlation_clock',
      ownerPublicId: 'user_public_1',
      sessionPublicId: 'session_public_1',
      actorPublicId: 'user_public_1',
    },
  };
  const databaseNowMs = Date.parse('2027-02-01T00:00:03.000Z');
  for (const expiresInDays of [30, 90, 365]) {
    const created = await repository.issue({ ...base, expiresInDays });
    assert.equal(created.kind, 'created');
    if (created.kind !== 'created') assert.fail('expected a created result');
    assert.equal(
      created.metadata.expiresAt,
      new Date(databaseNowMs + expiresInDays * 86_400_000).toISOString(),
    );
  }
  const inserts = calls.filter(({ sql }) => sql.startsWith('INSERT INTO account_api_keys'));
  assert.equal(inserts.length, 3);
  assert.equal((inserts.at(-1)?.values as unknown[]).at(-2), '2028-02-01 00:00:03.000');
  assert.equal((inserts.at(-1)?.values as unknown[]).at(-1), databaseNow);
});

test('rejects missing, fractional, and out-of-contract expiry durations in persistence', async () => {
  let inserts = 0;
  const connection = transactionalConnection(async (sql) => {
    if (sql.includes('FROM users')) {
      return [[{ status: 1, publicId: 'user_public_1' } as RowDataPacket], []];
    }
    if (sql.includes('UTC_TIMESTAMP(3) AS databaseNow')) {
      return [[{ databaseNow: '2027-02-01 00:00:03.000' } as RowDataPacket], []];
    }
    if (sql.startsWith('INSERT INTO account_api_keys')) inserts += 1;
    return [[], []];
  });
  const repository = new AccountApiKeyRepository(mysqlWith(connection), {} as AuditRepository);
  const base = {
    ownerUserPk: '1',
    keyPublicId: 'key_public_1',
    name: 'Automation',
    locator: Buffer.alloc(16, 1),
    tokenHash: Buffer.alloc(32, 2),
    scopeMask: 4,
    prefix: 'sbk_v1.AAAAAAAA…',
    auditContext: {
      correlationId: 'correlation_invalid_duration',
      ownerPublicId: 'user_public_1',
      sessionPublicId: 'session_public_1',
      actorPublicId: 'user_public_1',
    },
  };
  for (const expiresInDays of [undefined, 29, 30.5, 366]) {
    assert.deepEqual(await repository.issue({ ...base, expiresInDays } as never), {
      kind: 'invalid_expiry',
    });
  }
  assert.equal(inserts, 0);
});

test('returns credential expiry together with the same query database clock', async () => {
  let query = '';
  const connection = transactionalConnection(async (sql) => {
    query = sql;
    return [
      [
        {
          keyPk: '9',
          keyPublicId: 'key_public_9',
          ownerUserPk: '1',
          ownerPublicId: 'user_public_1',
          ownerStatus: 1,
          tokenHash: Buffer.alloc(32, 2),
          scopeMask: 4,
          persistedStatus: 1,
          expiresAt: '2027-02-01 00:00:03.000',
          databaseNow: '2027-02-01 00:00:03.000',
        } as RowDataPacket,
      ],
      [],
    ];
  });
  const repository = new AccountApiKeyRepository(mysqlWith(connection), {} as AuditRepository);
  const credential = await repository.findCredential(Buffer.alloc(16, 1));
  assert.match(query, /UTC_TIMESTAMP\(3\) AS databaseNow/u);
  assert.equal(credential?.expiresAt, Date.parse('2027-02-01T00:00:03.000Z'));
  assert.equal(credential?.databaseNow, Date.parse('2027-02-01T00:00:03.000Z'));
});

test('rejects credentials with malformed expiry or database-clock timestamps', async () => {
  const malformedCases = [
    { field: 'expiresAt', value: '2027-02-30 00:00:03.000' },
    { field: 'databaseNow', value: '2027-02-01T00:00:03.000Z' },
  ] as const;
  for (const { field, value } of malformedCases) {
    const connection = transactionalConnection(async () => [
      [
        {
          keyPk: '9',
          keyPublicId: 'key_public_9',
          ownerUserPk: '1',
          ownerPublicId: 'user_public_1',
          ownerStatus: 1,
          tokenHash: Buffer.alloc(32, 2),
          scopeMask: 4,
          persistedStatus: 1,
          expiresAt: '2027-02-02 00:00:03.000',
          databaseNow: '2027-02-01 00:00:03.000',
          [field]: value,
        } as RowDataPacket,
      ],
      [],
    ]);
    const repository = new AccountApiKeyRepository(mysqlWith(connection), {} as AuditRepository);
    assert.equal(await repository.findCredential(Buffer.alloc(16, 1)), null, field);
  }
});

test('revokes and marks use with constraint-safe database time when application clocks disagree', async () => {
  const calls: Array<{ sql: string; values?: unknown }> = [];
  const connection = transactionalConnection(async (sql, values) => {
    calls.push({ sql, values });
    if (sql.includes('FROM users')) {
      return [[{ status: 1, publicId: 'user_public_1' } as RowDataPacket], []];
    }
    if (sql.includes('FROM account_api_keys') && sql.endsWith('FOR UPDATE')) {
      return [
        [
          {
            id: '9',
            status: 1,
            createdAt: '2027-02-01 00:00:05.000',
            databaseNow: '2027-02-01 00:00:03.000',
          } as RowDataPacket,
        ],
        [],
      ];
    }
    return [{ affectedRows: 1 }, []];
  });
  const repository = new AccountApiKeyRepository(mysqlWith(connection), {
    writeMandatory: async () => undefined,
  } as never);
  await repository.revoke({
    ownerUserPk: '1',
    keyPublicId: 'key_public_9',
    auditContext: {
      correlationId: 'correlation_3',
      ownerPublicId: 'user_public_1',
      sessionPublicId: 'session_public_1',
      actorPublicId: 'user_public_1',
    },
  });
  await repository.markUsed('9');
  const revoke = calls.find(({ sql }) => sql.startsWith('UPDATE account_api_keys SET status = 2'));
  assert.match(revoke?.sql ?? '', /revoked_at = GREATEST\(\?, created_at\)/u);
  assert.deepEqual(revoke?.values, ['2027-02-01 00:00:03.000', '9']);
  const markUsed = calls.find(({ sql }) => sql.includes('SET last_used_at'));
  assert.match(markUsed?.sql ?? '', /GREATEST\(UTC_TIMESTAMP\(3\), created_at\)/u);
  assert.match(markUsed?.sql ?? '', /last_used_at < UTC_TIMESTAMP\(3\) - INTERVAL 60 SECOND/u);
  assert.deepEqual(markUsed?.values, ['9']);
  assert.equal(calls[0]?.sql.includes('FROM users'), true);
  assert.equal(calls[0]?.sql.endsWith('FOR UPDATE'), true);
});

test('denies revoke for missing and disabled owners before key locks, mutation, or audit', async () => {
  for (const ownerStatus of [null, 0] as const) {
    const calls: string[] = [];
    let auditCalls = 0;
    const connection = transactionalConnection(async (sql) => {
      calls.push(sql);
      if (sql.includes('FROM users')) {
        return ownerStatus === null
          ? [[], []]
          : [[{ status: ownerStatus, publicId: 'user_public_1' } as RowDataPacket], []];
      }
      throw new Error(`revoke denial reached a key query or mutation: ${sql}`);
    });
    const repository = new AccountApiKeyRepository(mysqlWith(connection), {
      writeMandatory: async () => {
        auditCalls += 1;
      },
    } as never);

    const result = await repository.revoke({
      ownerUserPk: '1',
      keyPublicId: 'key_public_9',
      auditContext: {
        correlationId: 'correlation_revoke_denied',
        ownerPublicId: 'user_public_1',
        sessionPublicId: 'session_public_1',
        actorPublicId: 'user_public_1',
      },
    });

    assert.deepEqual(result, { kind: 'owner_disabled' }, String(ownerStatus));
    assert.equal(calls.length, 1, String(ownerStatus));
    assert.equal(calls[0]?.includes('FROM users'), true, String(ownerStatus));
    assert.equal(calls[0]?.endsWith('FOR UPDATE'), true, String(ownerStatus));
    assert.equal(auditCalls, 0, String(ownerStatus));
  }
});

test('serializes list and revoke against an owner disable committed after guard admission', async () => {
  for (const operation of ['list', 'revoke'] as const) {
    let ownerStatus = 1;
    let resumeOwnerLock!: () => void;
    let observeOwnerLock!: () => void;
    const ownerLockObserved = new Promise<void>((resolve) => {
      observeOwnerLock = resolve;
    });
    const ownerLockResume = new Promise<void>((resolve) => {
      resumeOwnerLock = resolve;
    });
    const calls: string[] = [];
    const connection = transactionalConnection(async (sql) => {
      calls.push(sql);
      if (!sql.includes('FROM users')) {
        throw new Error(`${operation} raced past owner revalidation: ${sql}`);
      }
      observeOwnerLock();
      await ownerLockResume;
      return [[{ status: ownerStatus, publicId: 'user_public_1' } as RowDataPacket], []];
    });
    const repository = new AccountApiKeyRepository(mysqlWith(connection), {
      writeMandatory: async () => assert.fail(`${operation} denial must not audit success`),
    } as never);
    const auditContext = {
      correlationId: `correlation_${operation}_race`,
      ownerPublicId: 'user_public_1',
      sessionPublicId: 'session_public_1',
      actorPublicId: 'user_public_1',
    };
    const pending =
      operation === 'list'
        ? repository.list({
            ownerUserPk: '1',
            boundary: null,
            limit: 20,
            prefixFromLocator: () => 'unexpected',
            auditContext,
          })
        : repository.revoke({
            ownerUserPk: '1',
            keyPublicId: 'key_public_9',
            auditContext,
          });

    await ownerLockObserved;
    ownerStatus = 0;
    resumeOwnerLock();

    assert.deepEqual(await pending, { kind: 'owner_disabled' }, operation);
    assert.equal(calls.length, 1, operation);
  }
});

test('coalesces last-used writes in SQL and rechecks the full active snapshot under lock', async () => {
  const calls: string[] = [];
  const connection = transactionalConnection(async (sql) => {
    calls.push(sql);
    if (sql.includes('FROM account_api_keys k') && sql.endsWith('FOR UPDATE')) {
      return [
        [
          {
            keyPublicId: 'key_public_9',
            ownerUserPk: '1',
            ownerPublicId: 'user_public_1',
            ownerStatus: 1,
            scopeMask: 4,
            persistedStatus: 1,
            expiresAt: '2027-02-02 00:00:00.000',
          } as RowDataPacket,
        ],
        [],
      ];
    }
    return [{ affectedRows: 1 }, []];
  });
  const repository = new AccountApiKeyRepository(mysqlWith(connection), {} as AuditRepository);
  const snapshot = {
    keyPk: '9',
    keyPublicId: 'key_public_9',
    ownerUserPk: '1',
    ownerPublicId: 'user_public_1',
    scopeMask: 4,
    scopes: ['board:read'] as const,
    expiresAt: Date.parse('2027-02-02T00:00:00.000Z'),
  };
  assert.equal(await repository.recheckActive(connection, snapshot), true);
  assert.equal(
    calls.some((sql) => sql.includes('k.expires_at > UTC_TIMESTAMP(3)')),
    true,
  );
  await repository.markUsed('9');
  assert.equal(
    calls.some((sql) =>
      sql.includes('last_used_at IS NULL OR last_used_at < UTC_TIMESTAMP(3) - INTERVAL 60 SECOND'),
    ),
    true,
  );
});

test('fails an exact-expiry active recheck against fresh database time', async () => {
  let query = '';
  const connection = transactionalConnection(async (sql) => {
    query = sql;
    return [[], []];
  });
  const repository = new AccountApiKeyRepository(mysqlWith(connection), {} as AuditRepository);
  const snapshot = {
    keyPk: '9',
    keyPublicId: 'key_public_9',
    ownerUserPk: '1',
    ownerPublicId: 'user_public_1',
    scopeMask: 4,
    scopes: ['board:read'] as const,
    expiresAt: Date.parse('2027-02-02T00:00:00.000Z'),
  };
  assert.equal(await repository.recheckActive(connection, snapshot), false);
  assert.match(query, /k\.expires_at > UTC_TIMESTAMP\(3\)/u);
  assert.deepEqual(query.endsWith('FOR UPDATE'), true);
});
