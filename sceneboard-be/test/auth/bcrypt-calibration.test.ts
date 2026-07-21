import assert from 'node:assert/strict';
import { test } from 'node:test';

import { calibrateBcrypt, summarizeLatency } from '../../src/auth/bcrypt-calibration.js';

test('summarizes calibration latency with nearest-rank p95 and p99', () => {
  const result = summarizeLatency(Array.from({ length: 20 }, (_value, index) => index + 1));
  assert.deepEqual(result, { count: 20, medianMs: 10.5, p95Ms: 19, p99Ms: 20, maxMs: 20 });
});

test('requires exact warmup/sample floors and withholds cost selection without a capacity budget', async () => {
  let hashes = 0;
  let compares = 0;
  const adapter = {
    async hash(_password: string, cost: number) {
      hashes += 1;
      return `hash-${cost}`;
    },
    async compare(_password: string, hash: string) {
      compares += 1;
      return hash === 'hash-10';
    },
  };
  const report = await calibrateBcrypt(adapter, {
    costs: [10],
    latencyGate: { medianMinMs: 0, medianMaxMs: 10_000, p95MaxMs: 10_000 },
  });
  assert.equal(report.warmupsPerCost, 3);
  assert.equal(report.samplesPerKind, 20);
  assert.deepEqual(report.concurrencyLevels, [1, 4, 8]);
  assert.equal(report.costs[0]?.hash.count, 20);
  assert.equal(report.costs[0]?.compare.count, 20);
  assert.equal(report.costs[0]?.capacity.length, 3);
  assert.equal(report.costs[0]?.capacityGatePassed, null);
  assert.equal(report.selectedCost, null);
  assert.equal(hashes, 83);
  assert.equal(compares, 83);
  await assert.rejects(
    () => calibrateBcrypt(adapter, { costs: [10], warmupsPerCost: 2 }),
    /three warmups/,
  );
  await assert.rejects(
    () => calibrateBcrypt(adapter, { costs: [10], samplesPerKind: 19 }),
    /twenty samples/,
  );
});
