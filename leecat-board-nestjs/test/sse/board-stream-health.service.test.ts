import assert from 'node:assert/strict';
import test from 'node:test';

import { BoardStreamHealthService } from '../../src/sse/board-stream-health.service.js';

test('readiness uses exact two-sample degradation and three-sample recovery thresholds', async () => {
  let oldestPendingAgeMs = 0;
  let quarantinedCorruptPending = false;
  const service = new BoardStreamHealthService(
    { getHealth: async () => ({ oldestPendingAgeMs, quarantinedCorruptPending }) },
    { pingCommand: async () => true, ensureSubscriberReady: async () => true } as never,
  );
  assert.equal(service.getOperationalHealth().ready, false);
  assert.equal((await service.sampleOnce()).ready, false);
  assert.equal((await service.sampleOnce()).ready, false);
  assert.equal((await service.sampleOnce()).ready, true);

  oldestPendingAgeMs = 9_999;
  assert.equal((await service.sampleOnce()).ready, true);
  oldestPendingAgeMs = 10_000;
  assert.equal((await service.sampleOnce()).ready, true);
  assert.equal((await service.sampleOnce()).ready, false);

  oldestPendingAgeMs = 5_001;
  assert.equal((await service.sampleOnce()).ready, false);
  oldestPendingAgeMs = 5_000;
  assert.equal((await service.sampleOnce()).ready, false);
  assert.equal((await service.sampleOnce()).ready, false);
  assert.equal((await service.sampleOnce()).ready, true);

  quarantinedCorruptPending = true;
  assert.equal((await service.sampleOnce()).ready, false);
});

test('dependency errors fail readiness immediately while liveness stays process-local', async () => {
  let fails = false;
  const service = new BoardStreamHealthService(
    { getHealth: async () => {
      if (fails) throw new Error('mysql unavailable');
      return { oldestPendingAgeMs: 0, quarantinedCorruptPending: false };
    } },
    { pingCommand: async () => true, ensureSubscriberReady: async () => true } as never,
  );
  await service.sampleOnce();
  await service.sampleOnce();
  assert.equal((await service.sampleOnce()).ready, true);
  fails = true;
  const health = await service.sampleOnce();
  assert.equal(health.live, true);
  assert.equal(health.ready, false);
  assert.equal(health.replayAvailable, false);
});
