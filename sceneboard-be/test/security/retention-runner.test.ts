import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { AuditRepository } from '../../src/audit/audit.repository.js';
import type { MysqlService } from '../../src/database/mysql.service.js';
import {
  SECURITY_RETENTION_TARGETS,
  SecurityRetentionService,
} from '../../src/maintenance/security-retention.service.js';

test('pins every retention cursor to a bounded supporting index', () => {
  assert.equal(SECURITY_RETENTION_TARGETS.length, 13);
  assert.equal(new Set(SECURITY_RETENTION_TARGETS.map((target) => target.name)).size, 13);
  assert.equal(
    SECURITY_RETENTION_TARGETS.every((target) => target.batchLimit === 500),
    true,
  );
  assert.equal(
    SECURITY_RETENTION_TARGETS.every((target) => target.indexName.startsWith('ix_')),
    true,
  );
  assert.equal(
    SECURITY_RETENTION_TARGETS.some((target) => target.name === 'pairing-approved-expiry'),
    true,
  );
  assert.equal(
    SECURITY_RETENTION_TARGETS.some((target) => target.name === 'security-audit-delete'),
    true,
  );
  const expiredSession = SECURITY_RETENTION_TARGETS.find(
    (target) => target.name === 'session-expired-delete',
  );
  assert.equal(expiredSession?.indexName, 'ix_sessions_status_absolute');
  assert.match(expiredSession?.selectSql ?? '', /absolute_expires_at <= \?/);
  assert.match(expiredSession?.selectSql ?? '', /NOT EXISTS \(SELECT 1 FROM security_audit_events/);
  const expiredGrant = SECURITY_RETENTION_TARGETS.find(
    (target) => target.name === 'grant-expired-delete',
  );
  assert.equal(expiredGrant?.indexName, 'ix_grants_status_expiry');
  assert.match(expiredGrant?.selectSql ?? '', /expires_at <= \?/);
});

test('status reports exact due counts and oldest UTC timestamps without a bounded selector', async () => {
  const calls: string[] = [];
  const connection = {
    async execute(sql: string) {
      calls.push(sql);
      return [[{ dueCount: '2', oldestDueAt: '2026-07-15 10:11:12.345' }], []];
    },
  };
  const mysql = {
    async withConnection<T>(work: (value: typeof connection) => Promise<T>) {
      return work(connection);
    },
  } as unknown as MysqlService;
  const service = new SecurityRetentionService(mysql, {} as AuditRepository);
  const report = await service.execute('status', Date.parse('2026-07-16T12:00:00.000Z'));
  assert.equal(report.selectedRows, 26);
  assert.equal(report.targets['pairing-created-expiry'], 2);
  assert.equal(report.oldestDueAt['pairing-created-expiry'], '2026-07-15T10:11:12.345Z');
  assert.equal(calls.length, 13);
  assert.equal(
    calls.every((sql) => /COUNT\(\*\) AS dueCount/.test(sql)),
    true,
  );
  assert.equal(
    calls.every((sql) => /MIN\(/.test(sql) && !/\bLIMIT\b/i.test(sql)),
    true,
  );
});

test('zero-wait named-lock overlap exits without selections or mutations', async () => {
  const calls: string[] = [];
  const connection = {
    async query(sql: string) {
      calls.push(sql);
      if (sql.includes('GET_LOCK')) return [[{ acquired: 0 }], []];
      return [[], []];
    },
  };
  const mysql = {
    async withConnection<T>(work: (value: typeof connection) => Promise<T>) {
      return work(connection);
    },
  } as unknown as MysqlService;
  const service = new SecurityRetentionService(mysql, {} as AuditRepository);
  const report = await service.execute('run', Date.parse('2026-07-16T12:00:00.000Z'));
  assert.equal(report.outcome, 'overlap');
  assert.equal(report.selectedRows, 0);
  assert.equal(calls.length, 1);
});

test('dry-run uses the same target selectors and performs no update or delete', async () => {
  const calls: string[] = [];
  const connection = {
    async query(sql: string) {
      calls.push(sql);
      if (sql.includes('GET_LOCK')) return [[{ acquired: 1 }], []];
      if (sql.includes('RELEASE_LOCK')) return [[{ released: 1 }], []];
      return [[], []];
    },
    async execute(sql: string) {
      calls.push(sql);
      return [[], []];
    },
  };
  const mysql = {
    async withConnection<T>(work: (value: typeof connection) => Promise<T>) {
      return work(connection);
    },
  } as unknown as MysqlService;
  const service = new SecurityRetentionService(mysql, {} as AuditRepository);
  const report = await service.execute('dry-run', Date.parse('2026-07-16T12:00:00.000Z'));
  assert.equal(report.outcome, 'success');
  assert.equal(calls.filter((sql) => /\bLIMIT 500\b/i.test(sql)).length, 13);
  assert.equal(
    calls.some((sql) => /^\s*(?:UPDATE|DELETE)\b/i.test(sql)),
    false,
  );
});

test('terminal deletion rechecks state and cutoff inside the committed batch', async () => {
  const calls: Array<{ sql: string; parameters: readonly unknown[] }> = [];
  let selected = false;
  const connection = {
    async query(sql: string) {
      if (sql.includes('GET_LOCK')) return [[{ acquired: 1 }], []];
      return [[], []];
    },
    async execute(sql: string, parameters: readonly unknown[] = []) {
      calls.push({ sql, parameters });
      if (
        sql.includes('FROM pairing_requests FORCE INDEX (ix_pairing_state_updated)') &&
        !selected
      ) {
        selected = true;
        return [[{ id: '41' }], []];
      }
      if (/^DELETE FROM pairing_requests/.test(sql)) return [{ affectedRows: 1 }, []];
      return [[], []];
    },
    async beginTransaction() {},
    async commit() {},
    async rollback() {},
  };
  const mysql = {
    async withConnection<T>(work: (value: typeof connection) => Promise<T>) {
      return work(connection);
    },
  } as unknown as MysqlService;
  const audit = { async writeMandatory() {} } as unknown as AuditRepository;
  const report = await new SecurityRetentionService(mysql, audit).execute(
    'run',
    Date.parse('2026-07-16T12:00:00.000Z'),
  );
  const deletion = calls.find((call) => /^DELETE FROM pairing_requests/.test(call.sql));
  assert.equal(report.mutatedRows, 1);
  assert.match(deletion?.sql ?? '', /state IN \(4,5,6,7,8\).*updated_at <= \?/s);
  assert.deepEqual(deletion?.parameters, ['41', new Date('2026-06-16T12:00:00.000Z')]);
});

test('approved pairing expiry preserves family-before-pair-before-grant order and clears secrets', async () => {
  const calls: string[] = [];
  let selected = false;
  const connection = {
    async query(sql: string) {
      calls.push(sql);
      if (sql.includes('GET_LOCK')) return [[{ acquired: 1 }], []];
      return [[], []];
    },
    async execute(sql: string) {
      calls.push(sql);
      if (
        sql.includes('FROM pairing_requests FORCE INDEX (ix_pairing_state_redeem_expiry)') &&
        !selected
      ) {
        selected = true;
        return [[{ id: '42' }], []];
      }
      if (sql.includes('SELECT s.family_public_id AS familyPublicId'))
        return [[{ familyPublicId: 'family-1' }], []];
      if (sql.includes('SELECT CAST(p.id AS CHAR) AS id'))
        return [
          [
            {
              id: '42',
              state: 3,
              publicId: 'pairing-1',
              ownerUserPublicId: 'user-1',
              sourceSessionPublicId: 'session-1',
              lockedFamilyPublicId: 'family-1',
              clientPublicId: 'client-1',
              grantDatabaseId: '43',
              due: 1,
            },
          ],
          [],
        ];
      if (sql.includes('SELECT public_id AS publicId, status FROM mcp_grants')) {
        return [[{ publicId: 'grant-1', status: 1 }], []];
      }
      if (/^UPDATE mcp_grants SET status = 4/.test(sql)) return [{ affectedRows: 1 }, []];
      if (/^\s*UPDATE pairing_requests SET state = 7/.test(sql)) return [{ affectedRows: 1 }, []];
      return [[], []];
    },
    async beginTransaction() {},
    async commit() {},
    async rollback() {},
  };
  const mysql = {
    async withConnection<T>(work: (value: typeof connection) => Promise<T>) {
      return work(connection);
    },
  } as unknown as MysqlService;
  const events: string[] = [];
  const audit = {
    async writeMandatory(_transaction: unknown, input: { event: string }) {
      events.push(input.event);
    },
  } as unknown as AuditRepository;
  const report = await new SecurityRetentionService(mysql, audit).execute(
    'run',
    Date.parse('2026-07-16T12:00:00.000Z'),
  );
  const familyLock = calls.findIndex((sql) =>
    sql.includes('FROM auth_sessions WHERE family_public_id'),
  );
  const pairingLock = calls.findIndex((sql) => sql.includes('SELECT CAST(p.id AS CHAR) AS id'));
  const grantLock = calls.findIndex((sql) =>
    sql.includes('SELECT public_id AS publicId, status FROM mcp_grants'),
  );
  const pairingUpdate = calls.find((sql) => /UPDATE pairing_requests SET state = 7/.test(sql));
  assert.equal(report.mutatedRows, 1);
  assert.equal(familyLock >= 0 && familyLock < pairingLock && pairingLock < grantLock, true);
  assert.match(pairingUpdate ?? '', /code_locator_hash = NULL, code_verifier_hash = NULL/);
  assert.deepEqual(events, ['grant_expire', 'pairing_expire', 'security_retention_run']);
});
