import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { PoolConnection } from 'mysql2/promise';

import type { SessionRecord } from '../../src/auth/session.service.js';
import { AppError } from '../../src/common/errors/app-error.js';
import { CryptoService } from '../../src/common/security/crypto.service.js';
import { MysqlService } from '../../src/database/mysql.service.js';
import type { BoardAccessPolicy } from '../../src/grants/board-access.policy.js';
import type { InvitationMailPort } from '../../src/invitations/invitation-mail.port.js';
import {
  InvitationRepository,
  type LockedInvitation,
} from '../../src/invitations/invitation.repository.js';
import { InvitationService } from '../../src/invitations/invitation.service.js';
import { InvitationTokenService } from '../../src/invitations/invitation-token.service.js';
import type { RateLimitService } from '../../src/rate-limit/rate-limit.service.js';

const crypto = new CryptoService(
  {
    sessionToken: Buffer.alloc(32, 1),
    grantToken: Buffer.alloc(32, 2),
    csrf: Buffer.alloc(32, 3),
    pairingCodePepper: Buffer.alloc(32, 4),
    auditHmac: Buffer.alloc(32, 5),
    rateLimitHmac: Buffer.alloc(32, 6),
  },
  (length) => Buffer.alloc(length, 7),
);

const tokens = new InvitationTokenService(crypto);
const issued = tokens.issue();
const session: SessionRecord = {
  databaseId: '23',
  publicId: 'session_1',
  familyPublicId: 'family_1',
  tokenHash: Buffer.alloc(32),
  status: 'active',
  user: {
    databaseId: '23',
    publicId: 'account_23',
    email: 'member@example.com',
    status: 'active',
    createdAt: '2026-07-20T00:00:00.000Z',
  },
  idleExpiresAt: Date.parse('2026-08-01T00:00:00.000Z'),
  absoluteExpiresAt: Date.parse('2026-08-10T00:00:00.000Z'),
};

const invitation = (state: LockedInvitation['state']): LockedInvitation => ({
  invitationPk: 31n,
  inviteId: 'invite_31',
  boardPk: 11n,
  boardId: 'board_1',
  boardTitle: 'Board',
  ownerAccountPk: 17n,
  emailNormalized: 'member@example.com',
  role: 'editor',
  state,
  tokenDigest: issued.digest,
  version: state === 'pending' ? 1 : 2,
  acceptedAccountPk: state === 'accepted' ? 23n : null,
  expiresAtSql: '2026-08-04 00:00:00.000',
});

const connection = (calls: string[]): PoolConnection =>
  ({
    query: async (sql: string) => {
      calls.push(sql.startsWith('SET TRANSACTION') ? 'isolation' : 'query');
      return [[], []];
    },
    beginTransaction: async () => {
      calls.push('begin');
    },
    commit: async () => {
      calls.push('commit');
    },
    rollback: async () => {
      calls.push('rollback');
    },
    execute: async (sql: string) => {
      if (sql.includes('UTC_TIMESTAMP')) return [[{ nowSql: '2026-07-28 00:00:00.000' }], []];
      throw new Error('unexpected SQL');
    },
  }) as unknown as PoolConnection;

const service = (repository: Partial<InvitationRepository>, calls: string[]): InvitationService => {
  const mysql = {
    withConnection: async <Value>(apply: (connection: PoolConnection) => Promise<Value>) =>
      apply(connection(calls)),
  } as MysqlService;
  return new InvitationService(
    {} as BoardAccessPolicy,
    mysql,
    repository as InvitationRepository,
    tokens,
    { sendInvitation: async () => undefined } as InvitationMailPort,
    { consume: async () => undefined } as unknown as RateLimitService,
  );
};

test('accept locks board, invite, verified account, and membership before one epoch/outbox commit', async () => {
  const calls: string[] = [];
  const result = await service(
    {
      discoverByLocator: async () => 11n,
      lockBoardByPk: async () => {
        calls.push('board');
        return {
          boardPk: '11',
          boardId: 'board_1',
          ownerAccountPk: '17',
          capabilityEpoch: '4',
        };
      },
      lockByLocator: async () => {
        calls.push('invite');
        return invitation('pending');
      },
      lockAccountByPk: async () => {
        calls.push('account');
        return {
          accountPk: 23n,
          accountId: 'account_23',
          emailNormalized: 'member@example.com',
          displayName: 'Member',
        };
      },
      lockMembershipByAccount: async () => {
        calls.push('membership');
        return null;
      },
      createOrReactivateMembership: async () => {
        calls.push('membership-create');
        return {
          membershipPk: 41n,
          memberId: 'membership_41',
          accountPk: 23n,
          accountId: 'account_23',
          role: 'editor',
          state: 'active',
          version: 1,
        };
      },
      accept: async () => {
        calls.push('accept');
      },
      incrementEpochAndAppendInvalidation: async () => {
        calls.push('epoch-outbox');
        return 5;
      },
      writeAudit: async () => {
        calls.push('audit');
      },
    },
    calls,
  ).accept({ token: issued.token, session, ip: '192.0.2.1' });
  assert.deepEqual(result, {
    membership: {
      boardId: 'board_1',
      accountId: 'account_23',
      role: 'editor',
      version: 1,
    },
    replayed: false,
  });
  assert.deepEqual(
    calls.filter((call) =>
      ['board', 'invite', 'account', 'membership', 'accept', 'epoch-outbox', 'audit'].includes(
        call,
      ),
    ),
    ['board', 'invite', 'account', 'membership', 'accept', 'epoch-outbox', 'audit'],
  );
  assert.equal(calls.includes('commit'), true);
  assert.equal(
    calls.some((call) => call.includes('session')),
    false,
  );
});

test('same-account accepted replay is read-only while email mismatch is one generic 404', async () => {
  const replayCalls: string[] = [];
  const replay = await service(
    {
      discoverByLocator: async () => 11n,
      lockBoardByPk: async () => ({
        boardPk: '11',
        boardId: 'board_1',
        ownerAccountPk: '17',
        capabilityEpoch: '5',
      }),
      lockByLocator: async () => invitation('accepted'),
      lockAccountByPk: async () => ({
        accountPk: 23n,
        accountId: 'account_23',
        emailNormalized: 'member@example.com',
        displayName: 'Member',
      }),
      lockMembershipByAccount: async () => ({
        membershipPk: 41n,
        memberId: 'membership_41',
        accountPk: 23n,
        accountId: 'account_23',
        role: 'editor',
        state: 'active',
        version: 1,
      }),
    },
    replayCalls,
  ).accept({ token: issued.token, session, ip: '192.0.2.1' });
  assert.equal(replay.replayed, true);
  assert.equal(replayCalls.includes('commit'), true);

  const mismatchCalls: string[] = [];
  await assert.rejects(
    () =>
      service(
        {
          discoverByLocator: async () => 11n,
          lockBoardByPk: async () => ({
            boardPk: '11',
            boardId: 'board_1',
            ownerAccountPk: '17',
            capabilityEpoch: '5',
          }),
          lockByLocator: async () => invitation('pending'),
          lockAccountByPk: async () => ({
            accountPk: 23n,
            accountId: 'account_23',
            emailNormalized: 'other@example.com',
            displayName: 'Member',
          }),
        },
        mismatchCalls,
      ).accept({ token: issued.token, session, ip: '192.0.2.1' }),
    (error) => error instanceof AppError && error.code === 'INVITATION_NOT_FOUND',
  );
  assert.equal(mismatchCalls.includes('rollback'), true);
});

test('expiry observation commits terminal state before returning 410', async () => {
  const calls: string[] = [];
  await assert.rejects(
    () =>
      service(
        {
          discoverByLocator: async () => 11n,
          lockBoardByPk: async () => ({
            boardPk: '11',
            boardId: 'board_1',
            ownerAccountPk: '17',
            capabilityEpoch: '5',
          }),
          lockByLocator: async () => ({
            ...invitation('pending'),
            expiresAtSql: '2026-07-27 00:00:00.000',
          }),
          lockAccountByPk: async () => ({
            accountPk: 23n,
            accountId: 'account_23',
            emailNormalized: 'member@example.com',
            displayName: 'Member',
          }),
          markExpired: async () => {
            calls.push('expired');
          },
        },
        calls,
      ).accept({ token: issued.token, session, ip: '192.0.2.1' }),
    (error) => error instanceof AppError && error.code === 'INVITATION_GONE',
  );
  assert.equal(calls.includes('expired'), true);
  assert.equal(calls.includes('commit'), true);
  assert.equal(calls.includes('rollback'), false);
});
