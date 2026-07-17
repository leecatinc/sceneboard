import assert from 'node:assert/strict';
import test from 'node:test';

import {
  plannedRecycleJitterMsV1,
  reconnectBackoffMsV1,
} from '../../src/sse/reconnect-backoff.js';

test('uses pinned full-jitter retry bases and a 15-second cap', () => {
  assert.equal(reconnectBackoffMsV1(1, () => 0), 0);
  assert.equal(reconnectBackoffMsV1(1, () => 0.999_999), 500);
  assert.equal(reconnectBackoffMsV1(2, () => 0.999_999), 1_000);
  assert.equal(reconnectBackoffMsV1(6, () => 0.999_999), 15_000);
  assert.equal(reconnectBackoffMsV1(100, () => 0.999_999), 15_000);
});

test('keeps planned recycle jitter inside the inclusive 100-300ms window', () => {
  assert.equal(plannedRecycleJitterMsV1(() => 0), 100);
  assert.equal(plannedRecycleJitterMsV1(() => 0.999_999), 300);
});
