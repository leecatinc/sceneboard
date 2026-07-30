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
  const connection = transactionalConnection(async (sql) => {
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
    now: Date.parse('2030-01-01T00:00:00.000Z'),
    prefixFromLocator: (locator) => `prefix-${locator[0]}`,
    auditContext: {
      correlationId: 'correlation_1',
      ownerPublicId: 'user_public_1',
      sessionPublicId: 'session_public_1',
      actorPublicId: 'user_public_1',
    },
  });
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
});

test('enforces the ten-active-key quota while holding the owner row lock', async () => {
  const calls: string[] = [];
  const connection = transactionalConnection(async (sql) => {
    calls.push(sql);
    if (sql.includes('FROM users')) {
      return [[{ status: 1, publicId: 'user_public_1' } as RowDataPacket], []];
    }
    if (sql.includes('COUNT(*) AS activeCount')) {
      return [[{ activeCount: 10 } as RowDataPacket], []];
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
    expiresAt: Date.parse('2027-05-02T00:00:00.000Z'),
    now: Date.parse('2027-02-01T00:00:00.000Z'),
    prefix: 'sbk_v1.AAAAAAAA…',
    auditContext: {
      correlationId: 'correlation_2',
      ownerPublicId: 'user_public_1',
      sessionPublicId: 'session_public_1',
      actorPublicId: 'user_public_1',
    },
  });
  assert.deepEqual(result, { kind: 'quota_exceeded' });
  assert.equal(calls[0]?.endsWith('FOR UPDATE'), true);
  assert.equal(
    calls.some((sql) => sql.startsWith('INSERT')),
    false,
  );
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
  assert.equal(
    await repository.recheckActive(connection, snapshot, Date.parse('2027-02-01T00:00:00.000Z')),
    true,
  );
  await repository.markUsed('9', Date.parse('2027-02-01T00:00:00.000Z'));
  assert.equal(
    calls.some((sql) => sql.includes('last_used_at IS NULL OR last_used_at < ?')),
    true,
  );
});
