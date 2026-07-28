import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { PoolConnection, ResultSetHeader } from 'mysql2/promise';

import { AuditRepository } from '../../src/audit/audit.repository.js';
import { CryptoService } from '../../src/common/security/crypto.service.js';
import { InvitationRepository } from '../../src/invitations/invitation.repository.js';

const updated = (insertId = 0): ResultSetHeader =>
  ({
    affectedRows: 1,
    insertId,
  }) as ResultSetHeader;

test('atomically advances board epoch, durable sequence, and one resync outbox event', async () => {
  const calls: Array<{ sql: string; parameters: unknown[] }> = [];
  const connection = {
    execute: async (sql: string, parameters: unknown[] = []) => {
      calls.push({ sql, parameters });
      if (sql.includes('UPDATE boards')) return [updated(), []];
      if (sql.includes('FROM boards WHERE board_pk')) {
        return [
          [
            {
              boardPk: '11',
              boardId: 'board_1',
              ownerAccountPk: '17',
              capabilityEpoch: '8',
            },
          ],
          [],
        ];
      }
      if (sql.includes('FROM board_heads h')) {
        return [
          [
            {
              revisionId: Buffer.from('00112233445546778899aabbccddeeff', 'hex'),
              lastEventSequence: '4',
            },
          ],
          [],
        ];
      }
      if (sql.includes('UPDATE board_heads')) return [updated(), []];
      if (sql.includes('INSERT INTO board_event_outbox')) return [updated(9), []];
      throw new Error('unexpected SQL');
    },
  } as unknown as PoolConnection;
  const crypto = new CryptoService({
    sessionToken: Buffer.alloc(32, 1),
    grantToken: Buffer.alloc(32, 2),
    csrf: Buffer.alloc(32, 3),
    pairingCodePepper: Buffer.alloc(32, 4),
    auditHmac: Buffer.alloc(32, 5),
    rateLimitHmac: Buffer.alloc(32, 6),
  });
  const repository = new InvitationRepository(
    crypto,
    {} as AuditRepository,
    () => '11111111-1111-4111-8111-111111111111',
  );
  assert.equal(
    await repository.incrementEpochAndAppendInvalidation(connection, {
      boardPk: 11n,
      boardId: 'board_1',
      nowSql: '2026-07-28 00:00:00.000',
    }),
    8,
  );
  assert.equal(calls.filter((call) => call.sql.includes('UPDATE boards')).length, 1);
  assert.equal(calls.filter((call) => call.sql.includes('UPDATE board_heads')).length, 1);
  const outbox = calls.find((call) => call.sql.includes('INSERT INTO board_event_outbox'));
  assert.ok(outbox);
  assert.equal(outbox.parameters[2], 5);
  assert.match(Buffer.from(outbox.parameters[3] as Uint8Array).toString('utf8'), /server_reset/u);
  assert.match(
    Buffer.from(outbox.parameters[3] as Uint8Array).toString('utf8'),
    /stream\.resync\.required/u,
  );
});
