import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  calibratePairingClaims,
  PAIRING_CLAIM_CALIBRATION_COHORTS,
} from '../../src/pairing/pairing-claim-calibration.js';

test('calibrates all six pairing-unavailable cohorts at 1/4/8 with 500 attempts', async () => {
  let attempts = 0;
  const report = await calibratePairingClaims({
    async attempt() {
      attempts += 1;
      return { lookupLockHmacMs: 1, totalResponseMs: 100 };
    },
  }, {
    configuredFailureMinimumMs: 100,
    configuredFailureJitterMs: 20,
    capacityBudget: {
      maxConcurrency: 8,
      minThroughputPerSecond: 1,
      maxEventLoopDelayP95Ms: 10_000,
      maxRssDeltaBytes: 1_000_000_000,
      maxCohortDurationMs: 10_000,
    },
  });
  assert.equal(attempts, 500 * 6 * 3);
  assert.equal(report.measurements.length, PAIRING_CLAIM_CALIBRATION_COHORTS.length * 3);
  assert.equal(report.recommendedFailureMinimumMs, 26);
  assert.equal(report.maxPairwiseMedianDeltaMs, 0);
  assert.equal(report.maxPairwiseP95DeltaMs, 0);
  assert.equal(report.timingDistributionPassed, true);
  assert.equal(report.capacityGatePassed, true);
  assert.equal(report.accepted, true);
  await assert.rejects(() => calibratePairingClaims({ async attempt() { return { lookupLockHmacMs: 1, totalResponseMs: 1 }; } }, {
    configuredFailureMinimumMs: 100,
    configuredFailureJitterMs: 20,
    capacityBudget: report.capacityBudget,
    attemptsPerCohort: 499,
  }), /at least 500/);
});
