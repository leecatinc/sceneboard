import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PoolConnection, RowDataPacket } from 'mysql2/promise';

import type { AuditRepository } from '../../src/audit/audit.repository.js';
import { PasswordChangeRepository } from '../../src/auth/password-change.repository.js';
import type { MysqlService } from '../../src/database/mysql.service.js';

const compact = (sql: string): string => sql.replace(/\s+/g, ' ').trim();

const setup = (auditFails = false) => {
  const calls: string[] = [];
  const audits: Array<Record<string, unknown>> = [];
  const connection = {
    async query(sql: string) { calls.push(compact(sql)); return [[], []]; },
    async beginTransaction() { calls.push('BEGIN'); },
    async commit() { calls.push('COMMIT'); },
    async rollback() { calls.push('ROLLBACK'); },
    async execute(sql: string) {
      const statement = compact(sql);
      calls.push(statement);
      if (statement.startsWith('SELECT password_hash AS passwordHash')) {
        return [[{ passwordHash: 'hash:current-password', status: 1 } as RowDataPacket], []];
      }
      if (statement.startsWith('SELECT CAST(id AS CHAR) AS databaseId')) {
        return [[
          { databaseId: '10', familyPublicId: 'family_current', status: 1 } as RowDataPacket,
          { databaseId: '11', familyPublicId: 'family_other', status: 1 } as RowDataPacket,
        ], []];
      }
      if (statement.startsWith('SELECT CAST(p.id AS CHAR)')) {
        return [[{ id: '20', grantId: '30' } as RowDataPacket], []];
      }
      if (statement.startsWith('SELECT DISTINCT CAST(g.id AS CHAR)')) {
        return [[{ id: '30' } as RowDataPacket], []];
      }
      if (statement.startsWith('UPDATE users')) return [{ affectedRows: 1 }, []];
      return [[], []];
    },
  } as unknown as PoolConnection;
  const mysql = {
    async withConnection<Value>(operation: (value: PoolConnection) => Promise<Value>) {
      return operation(connection);
    },
  } as MysqlService;
  const audit = {
    async writeMandatory(_transaction: unknown, input: Record<string, unknown>) {
      calls.push('AUDIT');
      audits.push(input);
      if (auditFails) throw new Error('audit unavailable');
    },
  } as unknown as AuditRepository;
  return { repository: new PasswordChangeRepository(mysql, audit), calls, audits };
};

const input = {
  userDatabaseId: '1',
  userPublicId: 'user_1',
  currentSessionDatabaseId: '10',
  currentSessionPublicId: 'session_1',
  currentFamilyPublicId: 'family_current',
  expectedPasswordHash: 'hash:current-password',
  replacementPasswordHash: 'hash:replacement-password',
  now: 1_800_000_000_000,
};

test('atomically changes the password and revokes other session-linked credentials', async () => {
  const value = setup();

  assert.deepEqual(await value.repository.commit(input), {
    kind: 'changed',
    otherSessionFamiliesRevoked: 1,
  });
  const indexes = {
    user: value.calls.findIndex((call) => call.startsWith('SELECT password_hash AS passwordHash')),
    sessions: value.calls.findIndex((call) => call.startsWith('SELECT CAST(id AS CHAR) AS databaseId')),
    pairings: value.calls.findIndex((call) => call.startsWith('SELECT CAST(p.id AS CHAR)')),
    grants: value.calls.findIndex((call) => call.startsWith('SELECT DISTINCT CAST(g.id AS CHAR)')),
    credentials: value.calls.findIndex((call) => call.includes('FROM mcp_grant_credentials') && call.includes('FOR UPDATE')),
    audit: value.calls.indexOf('AUDIT'),
    commit: value.calls.indexOf('COMMIT'),
  };
  assert.ok(indexes.user < indexes.sessions && indexes.sessions < indexes.pairings);
  assert.ok(indexes.pairings < indexes.grants && indexes.grants < indexes.credentials);
  assert.ok(value.calls.some((call) => call.startsWith('UPDATE auth_sessions SET status = 3')));
  assert.ok(value.calls.some((call) => call.startsWith('UPDATE pairing_requests SET state = 7')));
  assert.ok(value.calls.some((call) => call.startsWith('UPDATE mcp_grants SET status = 4')));
  assert.ok(indexes.credentials < indexes.audit && indexes.audit < indexes.commit);
  assert.deepEqual(value.audits[0]?.metadata, { otherSessionFamiliesRevoked: 1 });
});

test('rolls back the password and revocation cascade when mandatory audit fails', async () => {
  const value = setup(true);
  await assert.rejects(() => value.repository.commit(input), /audit unavailable/);
  assert.equal(value.calls.includes('COMMIT'), false);
  assert.equal(value.calls.includes('ROLLBACK'), true);
});
