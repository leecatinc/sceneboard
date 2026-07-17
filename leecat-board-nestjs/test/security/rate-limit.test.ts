import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BoardOperationRateLimitPolicy } from '../../src/rate-limit/board-operation-rate-limit.policy.js';
import { RateLimitService, type RedisRateLimitPort } from '../../src/rate-limit/rate-limit.service.js';
import { AppError } from '../../src/common/errors/app-error.js';
import { CryptoService } from '../../src/common/security/crypto.service.js';

const key = Buffer.alloc(32, 6);
const crypto = new CryptoService({
  sessionToken: key,
  grantToken: key,
  csrf: key,
  pairingCodePepper: key,
  auditHmac: key,
  rateLimitHmac: key,
});

test('uses one atomic Lua call with an HMAC-only namespaced identity', async () => {
  let captured: { key: string; args: readonly string[] } | undefined;
  const redis: RedisRateLimitPort = {
    async consume(_script, key, args) {
      captured = { key, args };
      return [1, 600_000];
    },
  };
  const service = new RateLimitService(redis, crypto, 'leecat_board:');
  await service.consume({
    surface: 'login-ip',
    purpose: 'rate-limit-ip/v1',
    identity: '203.0.113.0/24',
    limit: 20,
    windowMs: 900_000,
  });
  assert.match(captured?.key ?? '', /^leecat_board:rate:v1:login-ip:[A-Za-z0-9_-]{43}$/);
  assert.equal(captured?.key.includes('203.0.113'), false);
  assert.deepEqual(captured?.args, ['20', '900000']);
});

test('maps over-limit TTL to an integer Retry-After and Redis loss to fail-closed 503', async () => {
  const limited = new RateLimitService({
    async consume() { return [6, 1_001]; },
  }, crypto, 'leecat_board:');
  await assert.rejects(() => limited.consume({
    surface: 'signup-ip', purpose: 'rate-limit-ip/v1', identity: 'ip', limit: 5, windowMs: 3_600_000,
  }), (error) => error instanceof AppError && error.code === 'RATE_LIMITED' && error.retryAfterSeconds === 2);

  const unavailable = new RateLimitService({
    async consume() { throw new Error('redis password must not leak'); },
  }, crypto, 'leecat_board:');
  await assert.rejects(() => unavailable.consume({
    surface: 'csrf-bootstrap', purpose: 'rate-limit-ip/v1', identity: 'ip', limit: 60, windowMs: 600_000, unavailableRetryAfterSeconds: 5,
  }), (error) => error instanceof AppError && error.code === 'SERVICE_UNAVAILABLE' && error.retryAfterSeconds === 5);
});

test('owns the exact five D1 operation classes and quotas in one catalog', () => {
  assert.deepEqual(BoardOperationRateLimitPolicy, {
    'board-read': { pre: [1_000, 300_000], post: [600, 300_000] },
    'capability-negotiation': { pre: [300, 300_000], post: [120, 300_000] },
    'board-mutation': { pre: [1_000, 300_000], post: [120, 300_000] },
    'board-create': { pre: [300, 3_600_000], post: [20, 3_600_000] },
    'board-archive': { pre: [300, 3_600_000], post: [30, 3_600_000] },
  });
});
