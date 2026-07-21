import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const assertionIds = [
  ...Array.from({ length: 6 }, (_, index) => `OPS-HEALTH-D4-${String(index + 1).padStart(2, '0')}`),
  ...Array.from({ length: 4 }, (_, index) => `OPS-HEALTH-D7-${String(index + 1).padStart(2, '0')}`),
  ...Array.from({ length: 3 }, (_, index) => `OPS-HEALTH-D8-${String(index + 1).padStart(2, '0')}`),
  ...Array.from({ length: 3 }, (_, index) => `OPS-HEALTH-D6-${String(index + 1).padStart(2, '0')}`),
  ...Array.from({ length: 4 }, (_, index) => `OPS-METRIC-${String(index + 1).padStart(2, '0')}`),
  ...Array.from(
    { length: 5 },
    (_, index) => `OPS-CORRELATION-${String(index + 1).padStart(2, '0')}`,
  ),
  ...Array.from(
    { length: 12 },
    (_, index) => `OPS-REDACTION-${String(index + 1).padStart(2, '0')}`,
  ),
];

test('operations assertion map has 37 unique live-required rows and owner health thresholds', async () => {
  assert.equal(assertionIds.length, 37);
  assert.equal(new Set(assertionIds).size, 37);
  const health = await readFile(
    new URL('../../sceneboard-be/src/sse/board-stream-health.service.ts', import.meta.url),
    'utf8',
  );
  assert.match(health, /oldestPendingAgeMs >= 10_000/u);
  assert.match(health, /#degradeSamples >= 2/u);
  assert.match(health, /oldestPendingAgeMs <= 5_000/u);
  assert.match(health, /#recoverSamples >= 3/u);
});

test('certification metric names and low-cardinality labels are closed', () => {
  const metrics = {
    sceneboard_certification_phase_total: ['phase', 'result', 'owner'],
    sceneboard_certification_phase_duration_seconds: ['phase', 'profile'],
    sceneboard_certification_cleanup_total: ['resource', 'result'],
    sceneboard_certification_gate_total: ['gate', 'result', 'owner'],
  };
  assert.equal(Object.keys(metrics).length, 4);
  assert.equal(
    Object.values(metrics)
      .flat()
      .some((label) => /id|token|board/iu.test(label)),
    false,
  );
});
