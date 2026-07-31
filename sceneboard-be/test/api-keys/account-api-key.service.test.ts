import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AccountApiKeyService } from '../../src/api-keys/account-api-key.service.js';
import { AccountApiKeyTokenCodec } from '../../src/api-keys/account-api-key-token.codec.js';
import { AppError } from '../../src/common/errors/app-error.js';
import { CryptoService } from '../../src/common/security/crypto.service.js';
import { ActorContextService } from '../../src/grants/actor-context.service.js';
import { McpConnectionService } from '../../src/mcp/mcp-connection.service.js';

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

test('forwards requested expiry and delegates the default to the database transaction', async () => {
  const expiries: Array<number | undefined> = [];
  const crypto = cryptoService();
  const repository = {
    issue: async (input: {
      keyPublicId: string;
      prefix: string;
      expiresAt: number | undefined;
      name: string;
    }) => {
      expiries.push(input.expiresAt);
      const effectiveExpiry = input.expiresAt ?? now + 90 * 86_400_000;
      return {
        kind: 'created' as const,
        metadata: {
          apiKeyId: input.keyPublicId,
          name: input.name,
          prefix: input.prefix,
          scopes: ['board:read'] as const,
          status: 'active' as const,
          createdAt: new Date(now).toISOString(),
          expiresAt: new Date(effectiveExpiry).toISOString(),
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
  assert.deepEqual(expiries, [now + 86_400_000, undefined, now + 365 * 86_400_000]);
});

test('maps database-clock expiry validation to the public invalid-payload contract', async () => {
  const crypto = cryptoService();
  let expiresAt: number | undefined;
  const service = new AccountApiKeyService(
    {
      issue: async (input: { expiresAt: number | undefined }) => {
        expiresAt = input.expiresAt;
        return { kind: 'invalid_expiry' as const };
      },
    } as never,
    new AccountApiKeyTokenCodec(crypto),
    crypto,
    { consume: async () => undefined } as never,
    { accountApiKeyIssuanceEnabled: true, accountApiKeyAuthEnabled: true },
  );
  await assert.rejects(
    service.issue({ actor, name: 'Database clock bound', expiresAt: now + 86_400_000, now: 0 }),
    (error: unknown) => error instanceof AppError && error.code === 'INVALID_PAYLOAD',
  );
  assert.equal(expiresAt, now + 86_400_000);
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
      databaseNow: now,
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

test('rejects non-canonical snapshot scopes before the active database recheck', async () => {
  const driftCases = [
    { name: 'extra', scopeMask: 4, scopes: ['board:read', 'board:write'] },
    { name: 'missing', scopeMask: 4, scopes: [] },
    { name: 'duplicate', scopeMask: 4, scopes: ['board:read', 'board:read'] },
    { name: 'reordered', scopeMask: 4, scopes: ['board:write', 'board:read'] },
    { name: 'unknown', scopeMask: 4, scopes: ['unknown:scope'] },
    { name: 'invalid mask', scopeMask: 0, scopes: ['board:read'] },
  ] as const;
  for (const driftCase of driftCases) {
    let rechecks = 0;
    const service = new AccountApiKeyService(
      {
        recheckActive: async () => {
          rechecks += 1;
          return true;
        },
      } as never,
      new AccountApiKeyTokenCodec(cryptoService()),
      cryptoService(),
      { consume: async () => undefined } as never,
      { accountApiKeyIssuanceEnabled: true, accountApiKeyAuthEnabled: true },
    );
    await assert.rejects(
      service.recheckActive(
        {} as never,
        {
          keyPk: '9',
          keyPublicId: 'key_public_9',
          ownerUserPk: '1',
          ownerPublicId: 'user_public_1',
          scopeMask: driftCase.scopeMask,
          scopes: driftCase.scopes,
          expiresAt: now + 86_400_000,
        } as never,
        now,
      ),
      (error: unknown) => error instanceof AppError && error.code === 'UNAUTHENTICATED',
      driftCase.name,
    );
    assert.equal(rechecks, 0, driftCase.name);
  }
});

test('rechecks a canonical snapshot and preserves database lifecycle rejection', async () => {
  let active = true;
  const snapshots: unknown[] = [];
  const service = new AccountApiKeyService(
    {
      recheckActive: async (_connection: unknown, snapshot: unknown) => {
        snapshots.push(snapshot);
        return active;
      },
    } as never,
    new AccountApiKeyTokenCodec(cryptoService()),
    cryptoService(),
    { consume: async () => undefined } as never,
    { accountApiKeyIssuanceEnabled: true, accountApiKeyAuthEnabled: true },
  );
  const snapshot = {
    keyPk: '9',
    keyPublicId: 'key_public_9',
    ownerUserPk: '1',
    ownerPublicId: 'user_public_1',
    scopeMask: 4,
    scopes: ['board:read'] as const,
    expiresAt: now + 86_400_000,
  };
  await assert.doesNotReject(service.recheckActive({} as never, snapshot, now));
  active = false;
  await assert.rejects(
    service.recheckActive({} as never, snapshot, now),
    (error: unknown) => error instanceof AppError && error.code === 'UNAUTHENTICATED',
  );
  assert.deepEqual(snapshots, [snapshot, snapshot]);
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

test('attempts both failure buckets and writes the mandatory audit before surfacing a limiter error', async () => {
  const crypto = cryptoService();
  const tokens = new AccountApiKeyTokenCodec(crypto);
  const issued = tokens.issue();
  const calls: string[] = [];
  const audits: unknown[] = [];
  const repository = {
    findCredential: async () => null,
    writeAuthenticationAudit: async (input: unknown) => void audits.push(input),
  };
  const service = new AccountApiKeyService(
    repository as never,
    tokens,
    crypto,
    {
      consume: async (input: { surface: string }) => {
        calls.push(input.surface);
        if (input.surface === 'api-key-auth-failure-locator') {
          throw new AppError('RATE_LIMITED');
        }
      },
    } as never,
    { accountApiKeyIssuanceEnabled: true, accountApiKeyAuthEnabled: true },
  );
  await assert.rejects(
    service.resolveBearer(
      issued.token,
      { correlationId: 'correlation_limited', clientIp: '192.0.2.20' },
      now,
    ),
    (error: unknown) => error instanceof AppError && error.code === 'RATE_LIMITED',
  );
  assert.deepEqual(calls, ['api-key-auth-failure-locator', 'api-key-auth-failure-ip']);
  assert.equal(audits.length, 1);
});

test('skips credential lookup after locator or IP failure saturation without charging successes', async () => {
  for (const saturatedSurface of [
    'api-key-auth-failure-locator',
    'api-key-auth-failure-ip',
  ] as const) {
    const crypto = cryptoService();
    const tokens = new AccountApiKeyTokenCodec(crypto);
    const issued = tokens.issue();
    let lookups = 0;
    let shouldLimit = true;
    const limiterCalls: string[] = [];
    const audits: unknown[] = [];
    const service = new AccountApiKeyService(
      {
        findCredential: async () => {
          lookups += 1;
          return null;
        },
        writeAuthenticationAudit: async (input: unknown) => void audits.push(input),
      } as never,
      tokens,
      crypto,
      {
        consume: async (input: { surface: string }) => {
          limiterCalls.push(input.surface);
          if (shouldLimit && input.surface === saturatedSurface) {
            throw new AppError('RATE_LIMITED', { retryAfterSeconds: 300 });
          }
        },
      } as never,
      { accountApiKeyIssuanceEnabled: true, accountApiKeyAuthEnabled: true },
    );
    await assert.rejects(
      service.resolveBearer(
        issued.token,
        { correlationId: `correlation_${saturatedSurface}_first`, clientIp: '192.0.2.25' },
        now,
      ),
      (error: unknown) => error instanceof AppError && error.code === 'RATE_LIMITED',
    );
    shouldLimit = false;
    for (let repeat = 0; repeat < 25; repeat += 1) {
      await assert.rejects(
        service.resolveBearer(
          issued.token,
          {
            correlationId: `correlation_${saturatedSurface}_repeat_${repeat}`,
            clientIp: '192.0.2.25',
          },
          now,
        ),
        (error: unknown) =>
          error instanceof AppError &&
          error.code === 'RATE_LIMITED' &&
          error.retryAfterSeconds === 300,
      );
    }
    assert.equal(lookups, 1);
    assert.deepEqual(limiterCalls, ['api-key-auth-failure-locator', 'api-key-auth-failure-ip']);
    assert.equal(audits.length, 1);
  }
});

test('bounds durable audit work for repeated cached malformed-IP saturation', async () => {
  const limiterCalls: unknown[] = [];
  const audits: unknown[] = [];
  const service = new AccountApiKeyService(
    {
      writeAuthenticationAudit: async (input: unknown) => void audits.push(input),
    } as never,
    new AccountApiKeyTokenCodec(cryptoService()),
    cryptoService(),
    {
      consume: async (input: unknown) => {
        limiterCalls.push(input);
        throw new AppError('RATE_LIMITED', { retryAfterSeconds: 300 });
      },
    } as never,
    { accountApiKeyIssuanceEnabled: true, accountApiKeyAuthEnabled: true },
  );
  for (let request = 0; request < 26; request += 1) {
    await assert.rejects(
      service.resolveBearer(
        'not-a-token',
        { correlationId: `correlation_malformed_${request}`, clientIp: '192.0.2.29' },
        now,
      ),
      (error: unknown) =>
        error instanceof AppError &&
        error.code === 'RATE_LIMITED' &&
        error.retryAfterSeconds === 300,
    );
  }
  assert.equal(limiterCalls.length, 1);
  assert.equal(audits.length, 1);
});

test('uses database time for bearer expiry across positive, negative, and equality skew', async () => {
  const cases = [
    { name: 'application ahead', appNow: now + 86_400_000, databaseNow: now, expiresAt: now + 1 },
    { name: 'application behind', appNow: now - 86_400_000, databaseNow: now, expiresAt: now - 1 },
    { name: 'database equality', appNow: now - 86_400_000, databaseNow: now, expiresAt: now },
  ] as const;
  for (const testCase of cases) {
    const crypto = cryptoService();
    const tokens = new AccountApiKeyTokenCodec(crypto);
    const issued = tokens.issue();
    const service = new AccountApiKeyService(
      {
        findCredential: async () => ({
          keyPk: '9',
          keyPublicId: 'key_public_9',
          ownerUserPk: '1',
          ownerPublicId: 'user_public_1',
          ownerStatus: 1,
          tokenHash: issued.tokenHash,
          scopeMask: 4,
          persistedStatus: 1,
          expiresAt: testCase.expiresAt,
          databaseNow: testCase.databaseNow,
        }),
        writeAuthenticationAudit: async () => undefined,
        markUsed: async () => undefined,
      } as never,
      tokens,
      crypto,
      { consume: async () => undefined } as never,
      { accountApiKeyIssuanceEnabled: true, accountApiKeyAuthEnabled: true },
    );
    if (testCase.expiresAt > testCase.databaseNow) {
      const snapshot = await service.resolveBearer(
        issued.token,
        { correlationId: `correlation_${testCase.name}`, clientIp: '192.0.2.26' },
        testCase.appNow,
      );
      assert.equal(snapshot.keyPublicId, 'key_public_9');
    } else {
      await assert.rejects(
        service.resolveBearer(
          issued.token,
          { correlationId: `correlation_${testCase.name}`, clientIp: '192.0.2.26' },
          testCase.appNow,
        ),
        (error: unknown) => error instanceof AppError && error.code === 'UNAUTHENTICATED',
      );
    }
  }
});

test('admits the null-board MCP connection path only after database-clock authentication', async () => {
  const crypto = cryptoService();
  const tokens = new AccountApiKeyTokenCodec(crypto);
  const issued = tokens.issue();
  const accountApiKeys = new AccountApiKeyService(
    {
      findCredential: async () => ({
        keyPk: '9',
        keyPublicId: 'key_public_9',
        ownerUserPk: '1',
        ownerPublicId: 'user_public_1',
        ownerStatus: 1,
        tokenHash: issued.tokenHash,
        scopeMask: 4,
        persistedStatus: 1,
        expiresAt: now + 1,
        databaseNow: now,
      }),
      writeAuthenticationAudit: async () => undefined,
      markUsed: async () => undefined,
    } as never,
    tokens,
    crypto,
    { consume: async () => undefined } as never,
    { accountApiKeyIssuanceEnabled: true, accountApiKeyAuthEnabled: true },
  );
  const actors = new ActorContextService({} as never, {} as never, accountApiKeys);
  const principal = await actors.resolveAccountApiKey(
    issued.token,
    { correlationId: 'correlation_null_board', clientIp: '192.0.2.27' },
    now + 86_400_000,
  );
  const connection = new McpConnectionService(
    {
      withAuthorizedBoardTransaction: async () => assert.fail('null-board must not dispatch'),
    } as never,
    {} as never,
  );
  const result = await connection.get({
    principal,
    requestId: 'request_null_board' as never,
    boardId: null,
  });
  assert.equal(result.credential.status, 'active');
  assert.equal(result.selectedBoard, null);
});

test('writes a malformed failure audit before surfacing rate-limit dependency failure', async () => {
  const audits: unknown[] = [];
  const service = new AccountApiKeyService(
    {
      writeAuthenticationAudit: async (input: unknown) => void audits.push(input),
    } as never,
    new AccountApiKeyTokenCodec(cryptoService()),
    cryptoService(),
    {
      consume: async () => {
        throw new AppError('SERVICE_UNAVAILABLE');
      },
    } as never,
    { accountApiKeyIssuanceEnabled: true, accountApiKeyAuthEnabled: true },
  );
  await assert.rejects(
    service.resolveBearer(
      'not-a-token',
      { correlationId: 'correlation_unavailable', clientIp: '192.0.2.21' },
      now,
    ),
    (error: unknown) => error instanceof AppError && error.code === 'SERVICE_UNAVAILABLE',
  );
  assert.equal(audits.length, 1);
});

test('maps every credential rejection reason to a secret-free failed audit', async () => {
  const cases = [
    { reason: 'unknown', credential: null },
    { reason: 'invalid', credential: { ownerStatus: 1, persistedStatus: 1, expiresAt: now + 1 } },
    {
      reason: 'owner_disabled',
      credential: { ownerStatus: 2, persistedStatus: 1, expiresAt: now + 1 },
    },
    { reason: 'revoked', credential: { ownerStatus: 1, persistedStatus: 2, expiresAt: now + 1 } },
    { reason: 'expired', credential: { ownerStatus: 1, persistedStatus: 1, expiresAt: now } },
  ] as const;
  for (const testCase of cases) {
    const crypto = cryptoService();
    const tokens = new AccountApiKeyTokenCodec(crypto);
    const issued = tokens.issue();
    const audits: Array<{ result: { reason: string; subjectFingerprint: Buffer | null } }> = [];
    const credential =
      testCase.credential === null
        ? null
        : {
            keyPk: '9',
            keyPublicId: 'key_public_9',
            ownerUserPk: '1',
            ownerPublicId: 'user_public_1',
            tokenHash:
              testCase.reason === 'invalid' ? Buffer.alloc(32, 99) : Buffer.from(issued.tokenHash),
            scopeMask: 4,
            ...testCase.credential,
            databaseNow: now,
          };
    const service = new AccountApiKeyService(
      {
        findCredential: async () => credential,
        writeAuthenticationAudit: async (input: (typeof audits)[number]) => void audits.push(input),
      } as never,
      tokens,
      crypto,
      { consume: async () => undefined } as never,
      { accountApiKeyIssuanceEnabled: true, accountApiKeyAuthEnabled: true },
    );
    await assert.rejects(
      service.resolveBearer(
        issued.token,
        { correlationId: `correlation_${testCase.reason}`, clientIp: '192.0.2.22' },
        now,
      ),
      (error: unknown) => error instanceof AppError && error.code === 'UNAUTHENTICATED',
    );
    assert.equal(audits[0]?.result.reason, testCase.reason);
    assert.equal(audits[0]?.result.subjectFingerprint?.byteLength, 32);
  }
});

test('keeps issuance and authentication kill switches closed without touching credentials', async () => {
  let repositoryCalls = 0;
  const repository = new Proxy(
    {},
    {
      get: () => () => {
        repositoryCalls += 1;
      },
    },
  );
  const crypto = cryptoService();
  const tokens = new AccountApiKeyTokenCodec(crypto);
  const service = new AccountApiKeyService(
    repository as never,
    tokens,
    crypto,
    { consume: async () => undefined } as never,
    { accountApiKeyIssuanceEnabled: false, accountApiKeyAuthEnabled: false },
  );
  await assert.rejects(
    service.issue({ actor, name: 'Disabled', now }),
    (error: unknown) => error instanceof AppError && error.code === 'SERVICE_UNAVAILABLE',
  );
  await assert.rejects(
    service.resolveBearer(
      tokens.issue().token,
      { correlationId: 'correlation_disabled', clientIp: '192.0.2.23' },
      now,
    ),
    (error: unknown) => error instanceof AppError && error.code === 'UNAUTHENTICATED',
  );
  assert.equal(repositoryCalls, 0);
});

test('keeps raw tokens out of persistence, audit, and mark-used failure signals', async () => {
  const crypto = cryptoService();
  const tokens = new AccountApiKeyTokenCodec(crypto);
  const persisted: unknown[] = [];
  const audits: unknown[] = [];
  const warnings: unknown[] = [];
  const repository = {
    issue: async (input: {
      keyPublicId: string;
      name: string;
      prefix: string;
      expiresAt: number | undefined;
      scopeMask: number;
      tokenHash: Buffer;
    }) => {
      persisted.push(input);
      return {
        kind: 'created' as const,
        metadata: {
          apiKeyId: input.keyPublicId,
          name: input.name,
          prefix: input.prefix,
          scopes: ['board:read'] as const,
          status: 'active' as const,
          createdAt: new Date(now).toISOString(),
          expiresAt: new Date(input.expiresAt ?? now + 90 * 86_400_000).toISOString(),
          lastUsedAt: null,
        },
      };
    },
    findCredential: async (locator: Buffer) => ({
      keyPk: '9',
      keyPublicId: 'key_public_9',
      ownerUserPk: '1',
      ownerPublicId: 'user_public_1',
      ownerStatus: 1,
      tokenHash: tokens.hash(rawToken),
      scopeMask: 4,
      persistedStatus: 1,
      expiresAt: now + 86_400_000,
      databaseNow: now,
      locator,
    }),
    writeAuthenticationAudit: async (input: unknown) => void audits.push(input),
    markUsed: async () => {
      throw new Error('simulated write failure');
    },
  };
  const service = new AccountApiKeyService(
    repository as never,
    tokens,
    crypto,
    { consume: async () => undefined } as never,
    { accountApiKeyIssuanceEnabled: true, accountApiKeyAuthEnabled: true },
    { warn: (input: unknown) => void warnings.push(input) },
  );
  const { apiKey: rawToken } = await service.issue({ actor, name: 'Canary', now });
  await service.resolveBearer(
    rawToken,
    { correlationId: 'correlation_canary', clientIp: '192.0.2.24' },
    now,
  );
  await new Promise((resolve) => setImmediate(resolve));
  const sinks = JSON.stringify({ persisted, audits, warnings });
  assert.equal(sinks.includes(rawToken), false);
  assert.deepEqual(warnings, [
    { event: 'account_api_key_mark_used_failed', keyPublicId: 'key_public_9' },
  ]);
});

test('keeps raw tokens out of repository issue collision and rejection signals', async () => {
  for (const failure of ['collision', 'rejection'] as const) {
    const crypto = cryptoService();
    const codec = new AccountApiKeyTokenCodec(crypto);
    const issuedTokens: string[] = [];
    const persisted: unknown[] = [];
    const warnings: unknown[] = [];
    const tokens = {
      issue: () => {
        const issued = codec.issue();
        issuedTokens.push(issued.token);
        return issued;
      },
      prefix: (locator: Uint8Array) => codec.prefix(locator),
    };
    const repository = {
      issue: async (input: unknown) => {
        persisted.push(input);
        if (failure === 'collision') return { kind: 'collision' as const };
        throw new Error('simulated repository issue failure');
      },
    };
    const service = new AccountApiKeyService(
      repository as never,
      tokens as never,
      crypto,
      { consume: async () => undefined } as never,
      { accountApiKeyIssuanceEnabled: true, accountApiKeyAuthEnabled: true },
      { warn: (input: unknown) => void warnings.push(input) },
    );
    let failureSignal = '';
    await assert.rejects(
      service.issue({ actor, name: `Canary ${failure}`, now }),
      (error: unknown) => {
        failureSignal = String(error);
        return (
          error instanceof Error &&
          (failure === 'collision'
            ? error instanceof AppError && error.code === 'SERVICE_UNAVAILABLE'
            : error.message === 'simulated repository issue failure')
        );
      },
    );
    assert.equal(issuedTokens.length, failure === 'collision' ? 5 : 1);
    const sinks = JSON.stringify({ persisted, warnings, failureSignal });
    for (const rawToken of issuedTokens) assert.equal(sinks.includes(rawToken), false, failure);
  }
});

test('keeps raw tokens out of mandatory issuance-audit rejection signals', async () => {
  const crypto = cryptoService();
  const codec = new AccountApiKeyTokenCodec(crypto);
  let rawToken = '';
  const persisted: unknown[] = [];
  const auditFailures: unknown[] = [];
  const warnings: unknown[] = [];
  const tokens = {
    issue: () => {
      const issued = codec.issue();
      rawToken = issued.token;
      return issued;
    },
    prefix: (locator: Uint8Array) => codec.prefix(locator),
  };
  const service = new AccountApiKeyService(
    {
      issue: async (input: unknown) => {
        persisted.push(input);
        const error = new Error('simulated mandatory issuance audit failure');
        auditFailures.push(error);
        throw error;
      },
    } as never,
    tokens as never,
    crypto,
    { consume: async () => undefined } as never,
    { accountApiKeyIssuanceEnabled: true, accountApiKeyAuthEnabled: true },
    { warn: (input: unknown) => void warnings.push(input) },
  );
  let failureSignal = '';
  await assert.rejects(service.issue({ actor, name: 'Canary audit', now }), (error: unknown) => {
    failureSignal = String(error);
    return error instanceof Error && error.message === 'simulated mandatory issuance audit failure';
  });
  const sinks = JSON.stringify({ persisted, auditFailures, warnings, failureSignal });
  assert.equal(rawToken.length, 73);
  assert.equal(sinks.includes(rawToken), false);
});

test('keeps raw tokens out of authentication-audit rejection signals', async () => {
  const crypto = cryptoService();
  const tokens = new AccountApiKeyTokenCodec(crypto);
  const issued = tokens.issue();
  const audits: unknown[] = [];
  const warnings: unknown[] = [];
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
      databaseNow: now,
    }),
    writeAuthenticationAudit: async (input: unknown) => {
      audits.push(input);
      throw new Error('simulated mandatory authentication audit failure');
    },
  };
  const service = new AccountApiKeyService(
    repository as never,
    tokens,
    crypto,
    { consume: async () => undefined } as never,
    { accountApiKeyIssuanceEnabled: true, accountApiKeyAuthEnabled: true },
    { warn: (input: unknown) => void warnings.push(input) },
  );
  let failureSignal = '';
  await assert.rejects(
    service.resolveBearer(
      issued.token,
      { correlationId: 'correlation_auth_audit_canary', clientIp: '192.0.2.28' },
      now,
    ),
    (error: unknown) => {
      failureSignal = String(error);
      return (
        error instanceof Error &&
        error.message === 'simulated mandatory authentication audit failure'
      );
    },
  );
  const sinks = JSON.stringify({ audits, warnings, failureSignal });
  assert.equal(sinks.includes(issued.token), false);
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
