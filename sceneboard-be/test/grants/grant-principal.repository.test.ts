import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { AuditRepository } from '../../src/audit/audit.repository.js';
import { GrantPrincipalRepository } from '../../src/grants/grant-principal.repository.js';
import type { MysqlService } from '../../src/database/mysql.service.js';
import type { CryptoService } from '../../src/common/security/crypto.service.js';

type QueryResult = readonly [unknown, unknown];

const setup = (row: Record<string, unknown>, boardIds = ['board_1']) => {
  const calls: string[] = [];
  const connection = {
    async query(sql: string) {
      calls.push(sql.trim().split(/\s+/).slice(0, 2).join(' '));
      return [[], []] as QueryResult;
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
      const normalized = sql.replace(/\s+/g, ' ').trim();
      calls.push(normalized);
      if (normalized.includes('FROM mcp_grant_boards')) {
        return [boardIds.map((boardPublicId) => ({ boardPublicId })), []] as QueryResult;
      }
      if (normalized.startsWith('SELECT')) return [[row], []] as QueryResult;
      return [{ affectedRows: 1 }, []] as QueryResult;
    },
  };
  const mysql = {
    async withConnection<T>(work: (value: typeof connection) => Promise<T>) {
      return work(connection);
    },
  } as unknown as MysqlService;
  const audits: Array<Record<string, unknown>> = [];
  const audit = {
    async writeMandatory(_transaction: unknown, input: Record<string, unknown>) {
      audits.push(input);
    },
  } as unknown as AuditRepository;
  const crypto = { hmac: () => Buffer.alloc(32, 1) } as unknown as CryptoService;
  return { repository: new GrantPrincipalRepository(mysql, audit, crypto), calls, audits };
};

const active = {
  ownerUserDatabaseId: '20',
  ownerUserPublicId: 'user_1',
  ownerUserStatus: 1,
  grantDatabaseId: '30',
  grantPublicId: 'grant_1',
  grantStatus: 2,
  grantLifetime: 2,
  grantExpiresAt: '2026-07-17 00:00:00.000',
  sourceFamilyPublicId: null,
  currentFamilySessionId: null,
  clientPublicId: 'client_1',
  clientName: 'SceneBoard Codex',
  installationId: 'install_abcdefghijklmnop',
  credentialDatabaseId: '40',
  credentialStatus: 1,
  scopeMask: 67,
  lifecycleMask: 1,
  activatedAt: '2026-07-16 11:00:00.000',
};

test('resolves one digest-matched active persistent credential without exposing raw bearer material', async () => {
  const value = setup(active);
  const result = await value.repository.resolve({
    locator: Buffer.alloc(16, 1),
    tokenHash: Buffer.alloc(32, 2),
    now: Date.parse('2026-07-16T12:00:00.000Z'),
  });
  assert.deepEqual(result, {
    ownerUserDatabaseId: '20',
    grantDatabaseId: '30',
    credentialDatabaseId: '40',
    clientPublicId: 'client_1',
    grantPublicId: 'grant_1',
    sourceFamilyPublicId: null,
    scopeMask: 67,
    connectionGrant: {
      grantId: 'grant_1',
      client: {
        clientId: 'client_1',
        clientName: 'SceneBoard Codex',
        installationFingerprint: Buffer.alloc(12, 1).toString('base64url'),
      },
      scopes: ['board.read', 'board.write', 'artifact.control'],
      lifecyclePermissions: ['board.create'],
      boardIds: ['board_1'],
      lifetime: 'persistent',
      status: 'active',
      activatedAt: '2026-07-16T11:00:00.000Z',
      expiresAt: '2026-07-17T00:00:00.000Z',
    },
  });
  assert.equal(
    value.calls.some((call) => call.includes('lcbg_v1')),
    false,
  );
  assert.deepEqual(value.audits, []);
});

test('resolves an active create grant before its first board is bound', async () => {
  const value = setup({ ...active, scopeMask: 2, lifecycleMask: 1 }, []);
  const result = await value.repository.resolve({
    locator: Buffer.alloc(16, 1),
    tokenHash: Buffer.alloc(32, 2),
    now: Date.parse('2026-07-16T12:00:00.000Z'),
  });
  assert.notEqual(result, null);
  if (result === null) throw new Error('create-capable grant was not resolved');
  assert.notEqual(result.connectionGrant, undefined);
  if (result.connectionGrant === undefined)
    throw new Error('create-capable grant projection is missing');
  assert.deepEqual(result.connectionGrant.boardIds, []);
  assert.deepEqual(result.connectionGrant.scopes, ['board.write']);
  assert.deepEqual(result.connectionGrant.lifecyclePermissions, ['board.create']);
});

test('rejects a zero-board grant that cannot create its first board', async () => {
  const value = setup({ ...active, scopeMask: 1, lifecycleMask: 0 }, []);
  await assert.rejects(
    () =>
      value.repository.resolve({
        locator: Buffer.alloc(16, 1),
        tokenHash: Buffer.alloc(32, 2),
        now: Date.parse('2026-07-16T12:00:00.000Z'),
      }),
    /invalid board bindings/,
  );
});

test('lazily expires a verified overdue credential and grant with mandatory audit', async () => {
  const value = setup({ ...active, grantExpiresAt: '2026-07-16 11:59:59.999' });
  const result = await value.repository.resolve({
    locator: Buffer.alloc(16, 1),
    tokenHash: Buffer.alloc(32, 2),
    now: Date.parse('2026-07-16T12:00:00.000Z'),
  });
  assert.equal(result, null);
  assert.equal(
    value.calls.some((call) => call.startsWith('UPDATE mcp_grant_credentials')),
    true,
  );
  assert.equal(
    value.calls.some((call) => call.startsWith('UPDATE mcp_grants')),
    true,
  );
  assert.equal(value.audits[0]?.event, 'grant_expire');
  assert.deepEqual(value.audits[0]?.metadata, { reason: 'deadline' });
});

test('requires a current active family for session-lifetime grant authorization', async () => {
  const value = setup({
    ...active,
    grantLifetime: 1,
    sourceFamilyPublicId: 'family_1',
    currentFamilySessionId: null,
  });
  const result = await value.repository.resolve({
    locator: Buffer.alloc(16, 1),
    tokenHash: Buffer.alloc(32, 2),
    now: Date.parse('2026-07-16T12:00:00.000Z'),
  });
  assert.equal(result, null);
  assert.deepEqual(value.audits[0]?.metadata, { reason: 'session_ended' });
});
