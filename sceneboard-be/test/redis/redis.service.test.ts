import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { AppEnvironment } from '../../src/config/env.schema.js';
import { RedisService } from '../../src/redis/redis.service.js';

const environment = {
  redis: {
    host: '127.0.0.1',
    port: 6379,
    password: 'test-only',
    database: 15,
    keyPrefix: 'sceneboard:',
  },
} as Pick<AppEnvironment, 'redis'>;

const serviceWithResult = (result: unknown): RedisService => {
  const service = new RedisService(environment);
  Object.assign(service as unknown as Record<string, unknown>, {
    command: {
      status: 'ready',
      eval: async () => result,
    },
  });
  return service;
};

test('Redis limiter adapter accepts only a two-positive-safe-integer numeric tuple', async () => {
  assert.deepEqual(await serviceWithResult([1, 1]).consume('script', 'key', []), [1, 1]);
  assert.deepEqual(
    await serviceWithResult([Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER]).consume(
      'script',
      'key',
      [],
    ),
    [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
  );

  for (const result of [
    null,
    [],
    [1],
    [1, 2, 3],
    ['1', 1],
    [1, '1'],
    [0, 1],
    [-1, 1],
    [1, 0],
    [1, -1],
    [1.5, 1],
    [1, 1.5],
    [Number.NaN, 1],
    [1, Number.NaN],
    [Number.MAX_SAFE_INTEGER + 1, 1],
    [1, Number.MAX_SAFE_INTEGER + 1],
  ]) {
    await assert.rejects(
      serviceWithResult(result).consume('script', 'key', []),
      /Redis limiter returned/u,
      JSON.stringify(result),
    );
  }
});
