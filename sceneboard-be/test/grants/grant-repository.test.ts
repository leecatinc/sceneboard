import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PoolConnection, RowDataPacket } from 'mysql2/promise';

import type { AuditRepository } from '../../src/audit/audit.repository.js';
import { CryptoService } from '../../src/common/security/crypto.service.js';
import type { MysqlService } from '../../src/database/mysql.service.js';
import { GrantRepository } from '../../src/grants/grant.repository.js';

const compact = (sql: string): string => sql.replace(/\s+/g, ' ').trim();
const key = Buffer.alloc(32, 9);
const crypto = new CryptoService({
  sessionToken: key,
  grantToken: key,
  csrf: key,
  pairingCodePepper: key,
  auditHmac: key,
  rateLimitHmac: key,
});

test('grant list uses one page query plus one batched binding query and projects crossed expiry without mutation', async () => {
  const calls: string[] = [];
  const connection = {
    async query(sql: string) {
      calls.push(compact(sql));
      return [[], []];
    },
    async beginTransaction() {
      calls.push('BEGIN');
    },
    async commit() {
      calls.push('COMMIT');
    },
    async rollback() {
      calls.push('ROLLBACK');
    },
    async execute(sql: string) {
      const statement = compact(sql);
      calls.push(statement);
      if (statement.includes('FROM mcp_grants g')) {
        return [
          [
            {
              id: '30',
              publicId: 'grant_1',
              ownerUserPublicId: 'user_1',
              clientPublicId: 'client_1',
              clientName: 'SceneBoard Codex',
              installationId: 'installation-0001',
              sourceSessionPublicId: null,
              scopeMask: 3,
              lifecycleMask: 1,
              lifetime: 2,
              status: 2,
              expiresAt: '2027-01-15 07:59:59.999',
              activatedAt: '2027-01-15 07:00:00.000',
              lastUsedAt: null,
              revokedAt: null,
              createdAt: '2027-01-14 08:00:00.000',
            } as RowDataPacket,
          ],
          [],
        ];
      }
      if (statement.includes('FROM mcp_grant_boards')) {
        return [[{ grantId: '30', boardPublicId: 'board_1' } as RowDataPacket], []];
      }
      return [[], []];
    },
  } as unknown as PoolConnection;
  const mysql = {
    async withConnection<Value>(operation: (value: PoolConnection) => Promise<Value>) {
      return operation(connection);
    },
  } as MysqlService;
  const repository = new GrantRepository(mysql, {} as AuditRepository, crypto);
  const result = await repository.list({
    ownerUserDatabaseId: '1',
    ownerUserPublicId: 'user_1',
    cursor: null,
    limit: 25,
    now: Date.parse('2027-01-15T08:00:00.000Z'),
  });
  assert.equal(result.grants[0]?.status, 'expired');
  assert.deepEqual(result.grants[0]?.boardIds, ['board_1']);
  assert.equal(result.nextTuple, null);
  assert.equal(calls.filter((call) => call.startsWith('SELECT')).length, 2);
  assert.equal(
    calls.some((call) => call.startsWith('UPDATE') || call.startsWith('INSERT')),
    false,
  );
  assert.equal(calls.includes('ROLLBACK'), false);
});
