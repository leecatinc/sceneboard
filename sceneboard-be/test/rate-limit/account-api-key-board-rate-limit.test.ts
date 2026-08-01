import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';

import type { ActiveAccountApiKeySnapshot } from '../../src/api-keys/account-api-key.repository.js';
import { AppError } from '../../src/common/errors/app-error.js';
import { CryptoService } from '../../src/common/security/crypto.service.js';
import type { AppEnvironment } from '../../src/config/env.schema.js';
import {
  ACCOUNT_API_KEY_SNAPSHOT,
  type ResolvedBoardPrincipalV1,
} from '../../src/grants/board-access.policy.js';
import {
  BoardOperationRateLimitGuard,
  type BoardOperationRateLimitClass,
} from '../../src/rate-limit/board-operation-rate-limit.policy.js';
import {
  type RateLimitInput,
  RateLimitService,
} from '../../src/rate-limit/rate-limit.service.js';

const snapshot: ActiveAccountApiKeySnapshot = {
  keyPk: '70',
  keyPublicId: 'key_public_1',
  ownerUserPk: '20',
  ownerPublicId: 'user_1',
  scopeMask: 63,
  scopes: [
    'board:archive',
    'board:create',
    'board:read',
    'board:write',
    'export:read',
    'history:read',
  ],
  expiresAt: Date.parse('2026-08-01T00:00:00.000Z'),
};

const principal = {
  kind: 'account_api_key',
  actor: {
    principalKind: 'service',
    principalId: snapshot.keyPublicId,
    grantId: null,
    scopes: [],
  },
  ownerUserPk: 20n,
  apiKeyPk: 70n,
  scopeMask: snapshot.scopeMask,
  isBrowserCredential: false,
  [ACCOUNT_API_KEY_SNAPSHOT]: snapshot,
} as unknown as ResolvedBoardPrincipalV1;

const context = (request: unknown): ExecutionContext =>
  ({
    getHandler: () => 'handler',
    getClass: () => 'controller',
    switchToHttp: () => ({ getRequest: () => request }),
  }) as unknown as ExecutionContext;

const expected = {
  'board-read': [
    ['api-key-op-board-read-key', 'rate-limit-api-key/v1', 'key_public_1', 600, 300_000],
    ['api-key-op-board-read-account', 'rate-limit-user/v1', 'user_1', 600, 300_000],
    ['api-key-op-board-read-ip', 'rate-limit-ip/v1', '192.0.2.10', 1_000, 300_000],
  ],
  'capability-negotiation': [
    ['api-key-op-capability-key', 'rate-limit-api-key/v1', 'key_public_1', 120, 300_000],
    ['api-key-op-capability-account', 'rate-limit-user/v1', 'user_1', 120, 300_000],
    ['api-key-op-capability-ip', 'rate-limit-ip/v1', '192.0.2.10', 300, 300_000],
  ],
  'board-mutation': [
    ['api-key-op-mutation-key', 'rate-limit-api-key/v1', 'key_public_1', 120, 300_000],
    ['api-key-op-mutation-account', 'rate-limit-user/v1', 'user_1', 120, 300_000],
    ['api-key-op-mutation-ip', 'rate-limit-ip/v1', '192.0.2.10', 1_000, 300_000],
  ],
  'board-create': [
    ['api-key-op-create-key', 'rate-limit-api-key/v1', 'key_public_1', 20, 3_600_000],
    ['api-key-op-create-account', 'rate-limit-user/v1', 'user_1', 20, 3_600_000],
    ['api-key-op-create-ip', 'rate-limit-ip/v1', '192.0.2.10', 300, 3_600_000],
  ],
  'board-archive': [
    ['api-key-op-archive-key', 'rate-limit-api-key/v1', 'key_public_1', 30, 3_600_000],
    ['api-key-op-archive-account', 'rate-limit-user/v1', 'user_1', 30, 3_600_000],
    ['api-key-op-archive-ip', 'rate-limit-ip/v1', '192.0.2.10', 300, 3_600_000],
  ],
} as const;

test('consumes successful API-key operation limits in key, account, then canonical-IP order', async () => {
  for (const operationClass of Object.keys(expected) as BoardOperationRateLimitClass[]) {
    const calls: RateLimitInput[] = [];
    const reflector = {
      getAllAndOverride: () => operationClass,
    } as unknown as Reflector;
    const limiter = {
      async consume(input: RateLimitInput) {
        calls.push(input);
      },
    } as RateLimitService;
    const guard = new BoardOperationRateLimitGuard(reflector, limiter, {
      trustedProxyCidrs: [],
    } as unknown as AppEnvironment);
    assert.equal(
      await guard.canActivate(
        context({
          headers: {},
          socket: { remoteAddress: '192.0.2.10' },
          boardPrincipal: principal,
        }),
      ),
      true,
    );
    assert.deepEqual(
      calls.map((call) => [call.surface, call.purpose, call.identity, call.limit, call.windowMs]),
      expected[operationClass],
    );
  }
});

test('skips non-key principals and fails closed without consuming later identities', async () => {
  const calls: RateLimitInput[] = [];
  const limiter = {
    async consume(input: RateLimitInput) {
      calls.push(input);
      if (calls.length === 2) throw new AppError('SERVICE_UNAVAILABLE');
    },
  } as RateLimitService;
  const guard = new BoardOperationRateLimitGuard(
    { getAllAndOverride: () => 'board-read' } as unknown as Reflector,
    limiter,
    { trustedProxyCidrs: [] } as unknown as AppEnvironment,
  );
  assert.equal(
    await guard.canActivate(
      context({
        headers: {},
        boardPrincipal: {
          kind: 'user',
          isBrowserCredential: true,
        },
      }),
    ),
    true,
  );
  assert.deepEqual(calls, []);
  await assert.rejects(
    guard.canActivate(
      context({
        headers: {},
        socket: { remoteAddress: '192.0.2.10' },
        boardPrincipal: principal,
      }),
    ),
    (error) => error instanceof AppError && error.code === 'SERVICE_UNAVAILABLE',
  );
  assert.deepEqual(
    calls.map((call: RateLimitInput) => call.purpose),
    ['rate-limit-api-key/v1', 'rate-limit-user/v1'],
  );
});

const crypto = new CryptoService({
  sessionToken: Buffer.alloc(32, 1),
  grantToken: Buffer.alloc(32, 2),
  csrf: Buffer.alloc(32, 3),
  pairingCodePepper: Buffer.alloc(32, 4),
  auditHmac: Buffer.alloc(32, 5),
  rateLimitHmac: Buffer.alloc(32, 6),
});

const rateLimitInput: RateLimitInput = {
  surface: 'api-key-op-board-read-key',
  purpose: 'rate-limit-api-key/v1',
  identity: 'key_public_1',
  limit: 5,
  windowMs: 300_000,
};

test('service boundary fails closed for every malformed tuple and preserves threshold semantics', async () => {
  for (const result of [
    null,
    [],
    [1],
    [1, 1, 1],
    ['1', 1],
    [1, '1'],
    [0, 1],
    [-1, 1],
    [1.5, 1],
    [Number.NaN, 1],
    [Number.MAX_SAFE_INTEGER + 1, 1],
    [1, 0],
    [1, -1],
    [1, 1.5],
    [1, Number.NaN],
    [1, Number.MAX_SAFE_INTEGER + 1],
    [1, rateLimitInput.windowMs + 1],
  ]) {
    const limiter = new RateLimitService(
      { consume: async () => result as never },
      crypto,
      'sceneboard:',
    );
    await assert.rejects(
      limiter.consume(rateLimitInput),
      (error) => error instanceof AppError && error.code === 'SERVICE_UNAVAILABLE',
      JSON.stringify(result),
    );
  }

  await assert.doesNotReject(
    new RateLimitService({ consume: async () => [5, 1] }, crypto, 'sceneboard:').consume(
      rateLimitInput,
    ),
  );
  await assert.rejects(
    new RateLimitService({ consume: async () => [6, 300_000] }, crypto, 'sceneboard:').consume(
      rateLimitInput,
    ),
    (error) =>
      error instanceof AppError &&
      error.code === 'RATE_LIMITED' &&
      error.retryAfterSeconds === 300,
  );
  await assert.rejects(
    new RateLimitService(
      { consume: async () => Promise.reject(new Error('redis unavailable')) },
      crypto,
      'sceneboard:',
    ).consume(rateLimitInput),
    (error) => error instanceof AppError && error.code === 'SERVICE_UNAVAILABLE',
  );
});

test('malformed limiter tuple prevents the protected handler path from being admitted', async () => {
  let calls = 0;
  const limiter = new RateLimitService(
    {
      async consume() {
        calls += 1;
        return [0, -1];
      },
    },
    crypto,
    'sceneboard:',
  );
  const guard = new BoardOperationRateLimitGuard(
    { getAllAndOverride: () => 'board-read' } as unknown as Reflector,
    limiter,
    { trustedProxyCidrs: [] } as unknown as AppEnvironment,
  );
  await assert.rejects(
    guard.canActivate(
      context({
        headers: {},
        socket: { remoteAddress: '192.0.2.10' },
        boardPrincipal: principal,
      }),
    ),
    (error) => error instanceof AppError && error.code === 'SERVICE_UNAVAILABLE',
  );
  assert.equal(calls, 1);
});
