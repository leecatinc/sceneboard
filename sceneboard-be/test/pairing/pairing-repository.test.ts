import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PoolConnection, RowDataPacket } from 'mysql2/promise';

import type { AuditRepository } from '../../src/audit/audit.repository.js';
import { CryptoService } from '../../src/common/security/crypto.service.js';
import type { PairingId } from '../../src/common/ids/public-id.js';
import type { GrantId } from '../../src/common/ids/public-id.js';
import type { BoardId, ShortText } from '@sceneboard/board-schema';
import type { MysqlService } from '../../src/database/mysql.service.js';
import { PairingRepository } from '../../src/pairing/pairing.repository.js';
import type { BoardCreateService } from '../../src/boards/board-create.service.js';

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
      if (statement.startsWith('SELECT s.family_public_id')) {
        return [[{ familyPublicId: 'family_1' } as RowDataPacket], []];
      }
      if (statement.includes('FROM auth_sessions') && statement.includes('family_public_id')) {
        return [
          [
            {
              status: 1,
              idleExpiresAt: '2027-01-15 10:00:00.000',
              absoluteExpiresAt: '2027-01-16 10:00:00.000',
            } as RowDataPacket,
          ],
          [],
        ];
      }
      if (statement.startsWith('SELECT CAST(p.id AS CHAR)')) {
        return [
          [
            {
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
            } as RowDataPacket,
          ],
          [],
        ];
      }
      if (
        statement.includes('FROM mcp_grants') &&
        statement.includes('WHERE id = ?') &&
        statement.includes('FOR UPDATE')
      ) {
        return [
          [
            {
              publicId: 'grant_1',
              status: 1,
              expiresAt: '2027-01-16 08:00:00.000',
              createdAt: '2027-01-15 07:59:30.000',
              activatedAt: null,
              lastUsedAt: null,
              revokedAt: null,
            } as RowDataPacket,
          ],
          [],
        ];
      }
      if (statement.includes('FROM mcp_grant_boards')) {
        return [[{ boardPublicId: 'board_1' } as RowDataPacket], []];
      }
      if (
        statement.startsWith('UPDATE mcp_grants') ||
        statement.startsWith('UPDATE pairing_requests')
      ) {
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
    async writeMandatory(_transaction: unknown, input: { event: string }) {
      audits.push(input.event);
    },
  } as unknown as AuditRepository;
  const repository = new PairingRepository(mysql, audit, crypto, {} as BoardCreateService);

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
    family: calls.findIndex(
      (call) => call.includes('FROM auth_sessions') && call.includes('FOR UPDATE'),
    ),
    pairing: calls.findIndex(
      (call) => call.includes('FROM pairing_requests p') && call.includes('FOR UPDATE'),
    ),
    grant: calls.findIndex(
      (call) => call.includes('FROM mcp_grants') && call.includes('FOR UPDATE'),
    ),
    credentials: calls.findIndex(
      (call) => call.includes('FROM mcp_grant_credentials') && call.includes('FOR UPDATE'),
    ),
    audit: calls.indexOf('AUDIT'),
    commit: calls.indexOf('COMMIT'),
  };
  assert.ok(
    indexes.family < indexes.pairing &&
      indexes.pairing < indexes.grant &&
      indexes.grant < indexes.credentials,
  );
  assert.ok(calls.some((call) => call.startsWith('INSERT INTO mcp_grant_credentials')));
  assert.ok(calls.some((call) => call.startsWith('UPDATE mcp_grants SET status = 2')));
  assert.ok(calls.some((call) => call.startsWith('UPDATE pairing_requests SET state = 4')));
  assert.ok(indexes.credentials < indexes.commit);
  assert.equal(calls.includes('ROLLBACK'), false);
});

test('approval-time board creation and grant issuance roll back together when mandatory audit fails', async () => {
  const events: string[] = [];
  const now = Date.parse('2027-01-15T08:00:00.000Z');
  const connection = {
    async query() {
      events.push('isolation');
      return [[], []];
    },
    async beginTransaction() {
      events.push('begin');
    },
    async commit() {
      events.push('commit');
    },
    async rollback() {
      events.push('rollback');
    },
    async execute(sql: string): Promise<[unknown, unknown]> {
      const statement = compact(sql);
      if (statement.startsWith('SELECT status FROM users'))
        return [[{ status: 1 } as RowDataPacket], []];
      if (statement.includes('FROM auth_sessions') && statement.includes('family_public_id')) {
        return [
          [
            {
              id: '2',
              status: 1,
              idleExpiresAt: '2027-01-15 09:00:00.000',
              absoluteExpiresAt: '2027-01-16 08:00:00.000',
            } as RowDataPacket,
          ],
          [],
        ];
      }
      if (
        statement.includes('FROM pairing_requests p') &&
        statement.includes('LEFT JOIN mcp_clients')
      ) {
        return [
          [
            {
              id: '10',
              publicId: 'pairing_1',
              state: 2,
              requestedScopeMask: 3,
              requestedLifecycleMask: 1,
              clientDatabaseId: '11',
              clientPublicId: 'client_1',
              clientName: 'Codex',
              installationId: 'installation_1',
              createdAt: '2027-01-15 07:59:00.000',
              codeExpiresAt: '2027-01-15 08:05:00.000',
              decisionExpiresAt: '2027-01-15 08:10:00.000',
            } as RowDataPacket,
          ],
          [],
        ];
      }
      if (statement.startsWith('INSERT INTO mcp_grants')) {
        events.push('grant');
        return [{ affectedRows: 1, insertId: 12 }, []];
      }
      if (statement.startsWith('INSERT INTO mcp_grant_boards')) {
        events.push('binding');
        return [{ affectedRows: 1, insertId: 0 }, []];
      }
      if (statement.startsWith('UPDATE pairing_requests')) {
        events.push('decision');
        return [{ affectedRows: 1, insertId: 0 }, []];
      }
      throw new Error(`unexpected SQL: ${statement}`);
    },
  } as unknown as PoolConnection;
  const mysql = {
    async withConnection<Value>(operation: (value: PoolConnection) => Promise<Value>) {
      return operation(connection);
    },
  } as MysqlService;
  const audit = {
    async writeMandatory() {
      events.push('audit-failure');
      throw new Error('mandatory audit unavailable');
    },
  } as unknown as AuditRepository;
  const boardCreate = {
    async createInTransaction(input: { connection: PoolConnection }) {
      assert.equal(input.connection, connection);
      events.push('board');
      return { result: { type: 'board.create', board: { boardId: 'board_new' as BoardId } } };
    },
  } as unknown as BoardCreateService;
  const repository = new PairingRepository(mysql, audit, crypto, boardCreate);

  const result = await repository.decide({
    pairingId: 'pairing_1' as PairingId,
    ownerUserDatabaseId: '1',
    ownerUserPublicId: 'user_1',
    approvingSessionDatabaseId: '2',
    approvingSessionPublicId: 'session_1',
    approvingFamilyPublicId: 'family_1',
    now,
    decision: 'approve',
    grantPublicId: 'grant_1' as GrantId,
    approvedScopeMask: 3,
    approvedLifecycleMask: 1,
    destination: { mode: 'create', title: '새 보드' as ShortText },
    lifetime: 'session',
  });

  assert.deepEqual(result, { kind: 'service_unavailable' });
  assert.deepEqual(events, [
    'isolation',
    'begin',
    'board',
    'grant',
    'binding',
    'decision',
    'audit-failure',
    'rollback',
  ]);
});
