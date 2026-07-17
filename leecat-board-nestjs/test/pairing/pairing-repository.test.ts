import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PoolConnection, RowDataPacket } from 'mysql2/promise';

import type { AuditRepository } from '../../src/audit/audit.repository.js';
import { CryptoService } from '../../src/common/security/crypto.service.js';
import type { PairingId } from '../../src/common/ids/public-id.js';
import type { MysqlService } from '../../src/database/mysql.service.js';
import { PairingRepository } from '../../src/pairing/pairing.repository.js';

const compact = (sql: string): string => sql.replace(/\s+/g, ' ').trim();
const key = Buffer.alloc(32, 5);
const crypto = new CryptoService({
  sessionToken: key,
  grantToken: key,
  csrf: key,
  pairingCodePepper: key,
  auditHmac: key,
  rateLimitHmac: key,
});

test('redemption locks family, pairing, grant, and credentials before one audited activation', async () => {
  const calls: string[] = [];
  const audits: string[] = [];
  const connection = {
    async query(sql: string) { calls.push(compact(sql)); return [[], []]; },
    async beginTransaction() { calls.push('BEGIN'); },
    async commit() { calls.push('COMMIT'); },
    async rollback() { calls.push('ROLLBACK'); },
    async execute(sql: string) {
      const statement = compact(sql);
      calls.push(statement);
      if (statement.startsWith('SELECT s.family_public_id')) {
        return [[{ familyPublicId: 'family_1' } as RowDataPacket], []];
      }
      if (statement.includes('FROM auth_sessions') && statement.includes('family_public_id')) {
        return [[{
          status: 1,
          idleExpiresAt: '2027-01-15 10:00:00.000',
          absoluteExpiresAt: '2027-01-16 10:00:00.000',
        } as RowDataPacket], []];
      }
      if (statement.startsWith('SELECT CAST(p.id AS CHAR)')) {
        return [[{
          id: '20',
          publicId: 'pairing_1',
          ownerUserPublicId: 'user_1',
          sourceSessionPublicId: 'session_1',
          state: 3,
          proofChallenge: Buffer.alloc(32, 8),
          claimedAt: '2027-01-15 07:59:00.000',
          decisionExpiresAt: '2027-01-15 08:09:00.000',
          redeemExpiresAt: '2027-01-15 08:02:00.000',
          requestedScopeMask: 3,
          requestedLifecycleMask: 1,
          approvedScopeMask: 3,
          approvedLifecycleMask: 1,
          lifetime: 1,
          grantDatabaseId: '30',
          grantPublicId: null,
          grantStatus: null,
          grantExpiresAt: null,
          grantCreatedAt: null,
          grantActivatedAt: null,
          grantLastUsedAt: null,
          grantRevokedAt: null,
          clientPublicId: 'client_1',
          clientName: 'SceneBoard Codex',
          installationId: 'installation-0001',
        } as RowDataPacket], []];
      }
      if (statement.includes('FROM mcp_grants') && statement.includes('WHERE id = ?') && statement.includes('FOR UPDATE')) {
        return [[{
          publicId: 'grant_1',
          status: 1,
          expiresAt: '2027-01-16 08:00:00.000',
          createdAt: '2027-01-15 07:59:30.000',
          activatedAt: null,
          lastUsedAt: null,
          revokedAt: null,
        } as RowDataPacket], []];
      }
      if (statement.includes('FROM mcp_grant_boards')) {
        return [[{ boardPublicId: 'board_1' } as RowDataPacket], []];
      }
      if (statement.startsWith('UPDATE mcp_grants') || statement.startsWith('UPDATE pairing_requests')) {
        return [{ affectedRows: 1 }, []];
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
    async writeMandatory(_transaction: unknown, input: { event: string }) { audits.push(input.event); },
  } as unknown as AuditRepository;
  const repository = new PairingRepository(mysql, audit, crypto);

  const result = await repository.redeem({
    pairingId: 'pairing_1' as PairingId,
    proofChallenge: Buffer.alloc(32, 8),
    credentialLocator: Buffer.alloc(16, 3),
    credentialHash: Buffer.alloc(32, 4),
    now: Date.parse('2027-01-15T08:00:00.000Z'),
  });
  assert.equal(result.kind, 'redeemed');
  if (result.kind !== 'redeemed') throw new Error('redemption did not commit');
  assert.equal(result.grant.status, 'active');
  assert.deepEqual(result.grant.boardIds, ['board_1']);
  assert.deepEqual(audits, ['pairing_redeem']);

  const indexes = {
    family: calls.findIndex((call) => call.includes('FROM auth_sessions') && call.includes('FOR UPDATE')),
    pairing: calls.findIndex((call) => call.includes('FROM pairing_requests p') && call.includes('FOR UPDATE')),
    grant: calls.findIndex((call) => call.includes('FROM mcp_grants') && call.includes('FOR UPDATE')),
    credentials: calls.findIndex((call) => call.includes('FROM mcp_grant_credentials') && call.includes('FOR UPDATE')),
    audit: calls.indexOf('AUDIT'),
    commit: calls.indexOf('COMMIT'),
  };
  assert.ok(indexes.family < indexes.pairing && indexes.pairing < indexes.grant && indexes.grant < indexes.credentials);
  assert.ok(calls.some((call) => call.startsWith('INSERT INTO mcp_grant_credentials')));
  assert.ok(calls.some((call) => call.startsWith('UPDATE mcp_grants SET status = 2')));
  assert.ok(calls.some((call) => call.startsWith('UPDATE pairing_requests SET state = 4')));
  assert.ok(indexes.credentials < indexes.commit);
  assert.equal(calls.includes('ROLLBACK'), false);
});
