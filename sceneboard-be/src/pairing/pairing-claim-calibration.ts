import { monitorEventLoopDelay } from 'node:perf_hooks';

import { summarizeLatency, type LatencySummary } from '../auth/bcrypt-calibration.js';

export const PAIRING_CLAIM_CALIBRATION_COHORTS = [
  'unknown_locator',
  'matched_verifier_mismatch',
  'expired',
  'consumed',
  'cancelled',
  'locked',
] as const;

export type PairingClaimCalibrationCohort = (typeof PAIRING_CLAIM_CALIBRATION_COHORTS)[number];

export interface PairingClaimCalibrationSample {
  lookupLockHmacMs: number;
  totalResponseMs: number;
}

export interface PairingClaimCalibrationHarness {
  attempt(cohort: PairingClaimCalibrationCohort): Promise<PairingClaimCalibrationSample>;
}

export interface PairingClaimCapacityBudget {
  maxConcurrency: 1 | 4 | 8;
  minThroughputPerSecond: number;
  maxEventLoopDelayP95Ms: number;
  maxRssDeltaBytes: number;
  maxCohortDurationMs: number;
}

export interface PairingClaimCohortMeasurement {
  cohort: PairingClaimCalibrationCohort;
  concurrency: 1 | 4 | 8;
  attempts: number;
  lookupLockHmac: LatencySummary;
  totalResponse: LatencySummary;
  durationMs: number;
  throughputPerSecond: number;
  eventLoopDelayP95Ms: number;
  rssDeltaBytes: number;
}

export interface PairingClaimCalibrationReport {
  schemaVersion: 1;
  attemptsPerCohort: number;
  concurrencyLevels: readonly [1, 4, 8];
  configuredFailureMinimumMs: number;
  configuredFailureJitterMs: number;
  recommendedFailureMinimumMs: number;
  maxPairwiseMedianDeltaMs: number;
  maxPairwiseP95DeltaMs: number;
  timingDistributionPassed: boolean;
  capacityBudget: PairingClaimCapacityBudget;
  capacityGatePassed: boolean;
  accepted: boolean;
  measurements: PairingClaimCohortMeasurement[];
}

const CONCURRENCY_LEVELS = [1, 4, 8] as const;
const rounded = (value: number): number => Math.round(value * 1_000) / 1_000;

const runCohort = async (
  harness: PairingClaimCalibrationHarness,
  cohort: PairingClaimCalibrationCohort,
  attempts: number,
  concurrency: 1 | 4 | 8,
): Promise<PairingClaimCohortMeasurement> => {
  const lookupSamples: number[] = [];
  const totalSamples: number[] = [];
  let cursor = 0;
  const rssBefore = process.memoryUsage().rss;
  const eventLoopDelay = monitorEventLoopDelay({ resolution: 10 });
  eventLoopDelay.enable();
  const startedAt = performance.now();
  const worker = async (): Promise<void> => {
    while (cursor < attempts) {
      cursor += 1;
      const sample = await harness.attempt(cohort);
      if (
        !Number.isFinite(sample.lookupLockHmacMs) ||
        sample.lookupLockHmacMs < 0 ||
        !Number.isFinite(sample.totalResponseMs) ||
        sample.totalResponseMs < sample.lookupLockHmacMs
      ) {
        throw new TypeError('pairing calibration harness returned an invalid sample');
      }
      lookupSamples.push(sample.lookupLockHmacMs);
      totalSamples.push(sample.totalResponseMs);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  const durationMs = performance.now() - startedAt;
  eventLoopDelay.disable();
  return {
    cohort,
    concurrency,
    attempts,
    lookupLockHmac: summarizeLatency(lookupSamples),
    totalResponse: summarizeLatency(totalSamples),
    durationMs: rounded(durationMs),
    throughputPerSecond: rounded(attempts / Math.max(durationMs / 1_000, 0.000_001)),
    eventLoopDelayP95Ms: rounded(Number(eventLoopDelay.percentile(95)) / 1_000_000),
    rssDeltaBytes: Math.max(0, process.memoryUsage().rss - rssBefore),
  };
};

const maxPairwiseDelta = (
  measurements: readonly PairingClaimCohortMeasurement[],
  field: 'medianMs' | 'p95Ms',
): number => {
  let maximum = 0;
  for (const concurrency of CONCURRENCY_LEVELS) {
    const values = measurements
      .filter((measurement) => measurement.concurrency === concurrency)
      .map((measurement) => measurement.totalResponse[field]);
    for (let left = 0; left < values.length; left += 1) {
      for (let right = left + 1; right < values.length; right += 1) {
        maximum = Math.max(maximum, Math.abs(values[left]! - values[right]!));
      }
    }
  }
  return rounded(maximum);
};

const validateBudget = (budget: PairingClaimCapacityBudget): void => {
  if (!CONCURRENCY_LEVELS.includes(budget.maxConcurrency))
    throw new TypeError('pairing capacity maxConcurrency must be 1, 4, or 8');
  for (const [key, value] of Object.entries(budget)) {
    if (key === 'maxConcurrency') continue;
    if (!Number.isFinite(value) || value <= 0)
      throw new TypeError(`pairing capacity budget ${key} must be positive`);
  }
};

export const calibratePairingClaims = async (
  harness: PairingClaimCalibrationHarness,
  input: Readonly<{
    configuredFailureMinimumMs: number;
    configuredFailureJitterMs: number;
    capacityBudget: PairingClaimCapacityBudget;
    attemptsPerCohort?: number;
  }>,
): Promise<PairingClaimCalibrationReport> => {
  const attempts = input.attemptsPerCohort ?? 500;
  if (!Number.isInteger(attempts) || attempts < 500)
    throw new TypeError('pairing calibration requires at least 500 attempts per cohort');
  if (!Number.isInteger(input.configuredFailureMinimumMs) || input.configuredFailureMinimumMs < 0) {
    throw new TypeError('pairing failure minimum must be a non-negative integer');
  }
  if (
    !Number.isInteger(input.configuredFailureJitterMs) ||
    input.configuredFailureJitterMs < 10 ||
    input.configuredFailureJitterMs > 25
  ) {
    throw new TypeError('pairing failure jitter must be an integer from 10 through 25');
  }
  validateBudget(input.capacityBudget);
  const measurements: PairingClaimCohortMeasurement[] = [];
  for (const concurrency of CONCURRENCY_LEVELS) {
    for (const cohort of PAIRING_CLAIM_CALIBRATION_COHORTS) {
      measurements.push(await runCohort(harness, cohort, attempts, concurrency));
    }
  }
  const slowestRawP99 = Math.max(
    ...measurements.map((measurement) => measurement.lookupLockHmac.p99Ms),
  );
  const recommendedFailureMinimumMs = Math.ceil(slowestRawP99 + 25);
  const maxPairwiseMedianDeltaMs = maxPairwiseDelta(measurements, 'medianMs');
  const maxPairwiseP95DeltaMs = maxPairwiseDelta(measurements, 'p95Ms');
  const timingDistributionPassed =
    input.configuredFailureMinimumMs >= recommendedFailureMinimumMs &&
    maxPairwiseMedianDeltaMs <= 10 &&
    maxPairwiseP95DeltaMs <= 25;
  const capacityMeasurements = measurements.filter(
    (measurement) => measurement.concurrency === input.capacityBudget.maxConcurrency,
  );
  const capacityGatePassed =
    capacityMeasurements.length === PAIRING_CLAIM_CALIBRATION_COHORTS.length &&
    capacityMeasurements.every(
      (measurement) =>
        measurement.throughputPerSecond >= input.capacityBudget.minThroughputPerSecond &&
        measurement.eventLoopDelayP95Ms <= input.capacityBudget.maxEventLoopDelayP95Ms &&
        measurement.rssDeltaBytes <= input.capacityBudget.maxRssDeltaBytes &&
        measurement.durationMs <= input.capacityBudget.maxCohortDurationMs,
    );
  return {
    schemaVersion: 1,
    attemptsPerCohort: attempts,
    concurrencyLevels: CONCURRENCY_LEVELS,
    configuredFailureMinimumMs: input.configuredFailureMinimumMs,
    configuredFailureJitterMs: input.configuredFailureJitterMs,
    recommendedFailureMinimumMs,
    maxPairwiseMedianDeltaMs,
    maxPairwiseP95DeltaMs,
    timingDistributionPassed,
    capacityBudget: input.capacityBudget,
    capacityGatePassed,
    accepted: timingDistributionPassed && capacityGatePassed,
    measurements,
  };
};
