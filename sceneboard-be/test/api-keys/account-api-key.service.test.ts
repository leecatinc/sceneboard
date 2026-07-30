import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AccountApiKeyService } from '../../src/api-keys/account-api-key.service.js';
import { AccountApiKeyTokenCodec } from '../../src/api-keys/account-api-key-token.codec.js';
import { AppError } from '../../src/common/errors/app-error.js';
import { CryptoService } from '../../src/common/security/crypto.service.js';

const now = Date.parse('2027-02-01T00:00:00.000Z');
const key = Buffer.alloc(32, 13);

const cryptoService = () => {
  let value = 0;
  return new CryptoService(
    {
      sessionToken: key,
      grantToken: key,
      csrf: key,
      pairingCodePepper: key,
      auditHmac: key,
      rateLimitHmac: key,
    },
    (length) => Buffer.alloc(length, (value += 1)),
  );
};

const actor = {
  ownerUserPk: '1',
  ownerPublicId: 'user_public_1',
  sessionPublicId: 'session_public_1',
  correlationId: 'correlation_1',
  clientIp: '192.0.2.10',
};

test('issues one key with the exact board-read default and safe metadata outcome', async () => {
  const crypto = cryptoService();
  const tokens = new AccountApiKeyTokenCodec(crypto);
  let observedMask = 0;
  const repository = {
    issue: async (input: { scopeMask: number; keyPublicId: string; prefix: string }) => {
      observedMask = input.scopeMask;
      return {
        kind: 'created' as const,
        metadata: {
          apiKeyId: input.keyPublicId,
          name: 'Automation',
          prefix: input.prefix,
          scopes: ['board:read'] as const,
          status: 'active' as const,
          createdAt: new Date(now).toISOString(),
          expiresAt: new Date(now + 90 * 86_400_000).toISOString(),
          lastUsedAt: null,
        },
      };
    },
  };
  const limiter = { consume: async () => undefined };
  const service = new AccountApiKeyService(repository as never, tokens, crypto, limiter as never, {
    accountApiKeyIssuanceEnabled: true,
    accountApiKeyAuthEnabled: true,
  });
  const result = await service.issue({ actor, name: 'Automation', now });
  assert.equal(observedMask, 4);
  assert.deepEqual(Object.keys(result.metadata), [
    'apiKeyId',
    'name',
    'prefix',
    'scopes',
    'status',
    'createdAt',
    'expiresAt',
    'lastUsedAt',
  ]);
  assert.deepEqual(result.metadata.scopes, ['board:read']);
  assert.equal(result.apiKey.length, 73);
});

test('accepts the inclusive one-day and 365-day expiry bounds and defaults to 90 days', async () => {
  const expiries: number[] = [];
  const crypto = cryptoService();
  const repository = {
    issue: async (input: {
      keyPublicId: string;
      prefix: string;
      expiresAt: number;
      name: string;
    }) => {
      expiries.push(input.expiresAt);
      return {
        kind: 'created' as const,
        metadata: {
          apiKeyId: input.keyPublicId,
          name: input.name,
          prefix: input.prefix,
          scopes: ['board:read'] as const,
          status: 'active' as const,
          createdAt: new Date(now).toISOString(),
          expiresAt: new Date(input.expiresAt).toISOString(),
          lastUsedAt: null,
        },
      };
    },
  };
  const service = new AccountApiKeyService(
    repository as never,
    new AccountApiKeyTokenCodec(crypto),
    crypto,
    { consume: async () => undefined } as never,
    { accountApiKeyIssuanceEnabled: true, accountApiKeyAuthEnabled: true },
  );
  await service.issue({ actor, name: 'One day', expiresAt: now + 86_400_000, now });
  await service.issue({ actor, name: 'Default', now });
  await service.issue({ actor, name: 'One year', expiresAt: now + 365 * 86_400_000, now });
  assert.deepEqual(expiries, [now + 86_400_000, now + 90 * 86_400_000, now + 365 * 86_400_000]);
  await assert.rejects(
    service.issue({ actor, name: 'Too short', expiresAt: now + 86_400_000 - 1, now }),
    (error: unknown) => error instanceof AppError && error.code === 'INVALID_PAYLOAD',
  );
  await assert.rejects(
    service.issue({ actor, name: 'Too long', expiresAt: now + 365 * 86_400_000 + 1, now }),
    (error: unknown) => error instanceof AppError && error.code === 'INVALID_PAYLOAD',
  );
});

test('applies account then IP management limits with the frozen tuples', async () => {
  const calls: unknown[] = [];
  const service = new AccountApiKeyService(
    {} as never,
    new AccountApiKeyTokenCodec(cryptoService()),
    cryptoService(),
    { consume: async (input: unknown) => void calls.push(input) } as never,
    { accountApiKeyIssuanceEnabled: true, accountApiKeyAuthEnabled: true },
  );
  await service.consumeManagementLimits('list', actor);
  assert.deepEqual(calls, [
    {
      surface: 'api-key-list-account',
      purpose: 'rate-limit-user/v1',
      identity: 'user_public_1',
      limit: 120,
      windowMs: 60_000,
    },
    {
      surface: 'api-key-list-ip',
      purpose: 'rate-limit-ip/v1',
      identity: '192.0.2.10',
      limit: 240,
      windowMs: 60_000,
    },
  ]);
});

test('resolves an active key, audits the safe key identity, and coalesces last-used asynchronously', async () => {
  const crypto = cryptoService();
  const tokens = new AccountApiKeyTokenCodec(crypto);
  const issued = tokens.issue();
  const audits: unknown[] = [];
  const used: string[] = [];
  const repository = {
    findCredential: async () => ({
      keyPk: '9',
      keyPublicId: 'key_public_9',
      ownerUserPk: '1',
      ownerPublicId: 'user_public_1',
      ownerStatus: 1,
      tokenHash: issued.tokenHash,
      scopeMask: 4,
      persistedStatus: 1,
      expiresAt: now + 86_400_000,
    }),
    writeAuthenticationAudit: async (input: unknown) => void audits.push(input),
    markUsed: async (keyPk: string) => void used.push(keyPk),
  };
  const service = new AccountApiKeyService(
    repository as never,
    tokens,
    crypto,
    { consume: async () => undefined } as never,
    { accountApiKeyIssuanceEnabled: true, accountApiKeyAuthEnabled: true },
  );
  const snapshot = await service.resolveBearer(
    issued.token,
    { correlationId: 'correlation_2', clientIp: '192.0.2.11' },
    now,
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(snapshot.scopes, ['board:read']);
  assert.equal(snapshot.keyPublicId, 'key_public_9');
  assert.deepEqual(used, ['9']);
  assert.deepEqual(audits, [
    {
      context: {
        correlationId: 'correlation_2',
        ownerPublicId: 'user_public_1',
        sessionPublicId: null,
        actorPublicId: 'key_public_9',
      },
      result: { succeeded: true, keyPublicId: 'key_public_9' },
    },
  ]);
});

test('charges only the IP bucket for malformed input and fails without disclosure', async () => {
  const calls: unknown[] = [];
  const audits: unknown[] = [];
  const repository = {
    writeAuthenticationAudit: async (input: unknown) => void audits.push(input),
  };
  const service = new AccountApiKeyService(
    repository as never,
    new AccountApiKeyTokenCodec(cryptoService()),
    cryptoService(),
    { consume: async (input: unknown) => void calls.push(input) } as never,
    { accountApiKeyIssuanceEnabled: true, accountApiKeyAuthEnabled: true },
  );
  await assert.rejects(
    service.resolveBearer(
      'not-a-token',
      { correlationId: 'correlation_3', clientIp: '192.0.2.12' },
      now,
    ),
    (error: unknown) => error instanceof AppError && error.code === 'UNAUTHENTICATED',
  );
  assert.deepEqual(calls, [
    {
      surface: 'api-key-auth-failure-ip',
      purpose: 'rate-limit-ip/v1',
      identity: '192.0.2.12',
      limit: 60,
      windowMs: 300_000,
    },
  ]);
  assert.equal(audits.length, 1);
});

test('charges locator then IP buckets for a well-formed unknown key', async () => {
  const crypto = cryptoService();
  const tokens = new AccountApiKeyTokenCodec(crypto);
  const issued = tokens.issue();
  const calls: unknown[] = [];
  const audits: unknown[] = [];
  const repository = {
    findCredential: async () => null,
    writeAuthenticationAudit: async (input: unknown) => void audits.push(input),
  };
  const service = new AccountApiKeyService(
    repository as never,
    tokens,
    crypto,
    { consume: async (input: unknown) => void calls.push(input) } as never,
    { accountApiKeyIssuanceEnabled: true, accountApiKeyAuthEnabled: true },
  );
  await assert.rejects(
    service.resolveBearer(
      issued.token,
      { correlationId: 'correlation_4', clientIp: '192.0.2.13' },
      now,
    ),
    (error: unknown) => error instanceof AppError && error.code === 'UNAUTHENTICATED',
  );
  assert.deepEqual(
    calls.map((call) => (call as { surface: string }).surface),
    ['api-key-auth-failure-locator', 'api-key-auth-failure-ip'],
  );
  assert.equal((audits[0] as { result: { keyPublicId: string | null } }).result.keyPublicId, null);
});

test('normalizes an unknown or non-owned management revoke to the API-key 404', async () => {
  const service = new AccountApiKeyService(
    { revoke: async () => ({ kind: 'not_found' as const }) } as never,
    new AccountApiKeyTokenCodec(cryptoService()),
    cryptoService(),
    { consume: async () => undefined } as never,
    { accountApiKeyIssuanceEnabled: true, accountApiKeyAuthEnabled: true },
  );
  await assert.rejects(
    service.revoke({ actor, keyPublicId: 'key_public_missing', now }),
    (error: unknown) => error instanceof AppError && error.code === 'API_KEY_NOT_FOUND',
  );
});
