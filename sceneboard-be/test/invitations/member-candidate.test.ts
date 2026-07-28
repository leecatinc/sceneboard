import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { PoolConnection } from 'mysql2/promise';

import { AuditRepository } from '../../src/audit/audit.repository.js';
import { CryptoService } from '../../src/common/security/crypto.service.js';
import { InvitationRepository } from '../../src/invitations/invitation.repository.js';

const crypto = new CryptoService({
  sessionToken: Buffer.alloc(32, 1),
  grantToken: Buffer.alloc(32, 2),
  csrf: Buffer.alloc(32, 3),
  pairingCodePepper: Buffer.alloc(32, 4),
  auditHmac: Buffer.alloc(32, 5),
  rateLimitHmac: Buffer.alloc(32, 6),
});

const repository = new InvitationRepository(crypto, {} as AuditRepository);

test('globally ranks exact email, display prefix, and standalone suggestion before top twenty', async () => {
  const rows = [
    ...Array.from({ length: 20 }, (_, index) => ({
      accountId: `account_prefix_${String(index).padStart(2, '0')}`,
      emailNormalized: `member${index}@example.com`,
      displayName: `Target ${String(index).padStart(2, '0')}`,
    })),
    {
      accountId: 'account_exact',
      emailNormalized: 'target@example.com',
      displayName: 'Zed',
    },
  ];
  const connection = {
    execute: async () => [rows],
  } as unknown as PoolConnection;
  const candidates = await repository.searchCandidates(connection, {
    normalizedQuery: 'target@example.com',
    completeEmail: 'target@example.com',
  });
  assert.equal(candidates.length, 20);
  assert.deepEqual(candidates[0], {
    kind: 'account',
    accountId: 'account_exact',
    displayName: 'Zed',
  });
  assert.equal(
    candidates.some((candidate) => candidate.kind === 'email'),
    false,
  );
});

test('dedupes account and email identities and emits no stored email on account candidates', async () => {
  const connection = {
    execute: async () => [
      [
        {
          accountId: 'account_1',
          emailNormalized: 'one@example.com',
          displayName: 'One',
        },
        {
          accountId: 'account_1',
          emailNormalized: 'one@example.com',
          displayName: 'One',
        },
      ],
    ],
  } as unknown as PoolConnection;
  const candidates = await repository.searchCandidates(connection, {
    normalizedQuery: 'one',
    completeEmail: null,
  });
  assert.deepEqual(candidates, [{ kind: 'account', accountId: 'account_1', displayName: 'One' }]);
  assert.equal(Object.hasOwn(candidates[0]!, 'email'), false);
});

test('adds one normalized complete-email suggestion after account results', async () => {
  const connection = {
    execute: async () => [[]],
  } as unknown as PoolConnection;
  assert.deepEqual(
    await repository.searchCandidates(connection, {
      normalizedQuery: 'new@example.com',
      completeEmail: 'new@example.com',
    }),
    [{ kind: 'email', email: 'new@example.com' }],
  );
});
