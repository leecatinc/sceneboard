import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PoolConnection, RowDataPacket } from 'mysql2/promise';

import { SessionsRepository } from '../../src/auth/sessions.repository.js';
import type { SessionRecord } from '../../src/auth/session.service.js';
import type { AuditRepository } from '../../src/audit/audit.repository.js';
import type { MysqlService } from '../../src/database/mysql.service.js';

const compact = (sql: string): string => sql.replace(/\s+/g, ' ').trim();

test('family terminalization locks sessions, pairings, grants, and credentials before one audited cascade', async () => {
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
      if (statement.startsWith('SELECT CAST(p.id AS CHAR)'))
        return [[{ id: '20', grantId: '30' } as RowDataPacket], []];
      if (statement.startsWith('SELECT DISTINCT CAST(g.id AS CHAR)')) {
        assert.match(statement, /ORDER BY id FOR UPDATE$/);
        return [[{ id: '30' } as RowDataPacket], []];
      }
      return [[], []];
    },
  } as unknown as PoolConnection;
  const mysql = {
    async withConnection<Value>(operation: (value: PoolConnection) => Promise<Value>) {
      return operation(connection);
    },
  } as MysqlService;
  const audit = {
    async writeMandatory() {
      calls.push('AUDIT');
    },
  } as unknown as AuditRepository;
  const repository = new SessionsRepository(mysql, audit);
  const record: SessionRecord = {
    databaseId: '10',
    publicId: 'session_1',
    familyPublicId: 'family_1',
    tokenHash: Buffer.alloc(32),
    status: 'active',
    user: {
      databaseId: '1',
      publicId: 'user_1',
      email: 'User@Example.dev',
      status: 'active',
      createdAt: '2026-07-16T00:00:00.000Z',
    },
    idleExpiresAt: 1_800_028_800_000,
    absoluteExpiresAt: 1_800_604_800_000,
  };

  assert.deepEqual(await repository.terminalizeFamily(record, 'reuse', 1_800_000_000_000), {
    kind: 'committed',
  });
  const indexes = {
    sessions: calls.findIndex(
      (call) => call.includes('FROM auth_sessions') && call.includes('FOR UPDATE'),
    ),
    pairings: calls.findIndex(
      (call) => call.includes('FROM pairing_requests p') && call.includes('FOR UPDATE'),
    ),
    grants: calls.findIndex(
      (call) => call.includes('FROM mcp_grants g') && call.includes('FOR UPDATE'),
    ),
    credentials: calls.findIndex(
      (call) => call.includes('FROM mcp_grant_credentials') && call.includes('FOR UPDATE'),
    ),
    audit: calls.indexOf('AUDIT'),
    commit: calls.indexOf('COMMIT'),
  };
  assert.ok(
    indexes.sessions < indexes.pairings &&
      indexes.pairings < indexes.grants &&
      indexes.grants < indexes.credentials,
  );
  assert.ok(calls.some((call) => call.startsWith('UPDATE pairing_requests SET state = 7')));
  assert.ok(calls.some((call) => call.startsWith('UPDATE mcp_grants SET status = 4')));
  assert.ok(calls.some((call) => call.startsWith('UPDATE mcp_grant_credentials SET status = 3')));
  assert.ok(indexes.credentials < indexes.audit && indexes.audit < indexes.commit);
  assert.equal(calls.includes('ROLLBACK'), false);
});
