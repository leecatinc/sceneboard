import { monitorEventLoopDelay } from 'node:perf_hooks';

export interface BcryptCalibrationAdapter {
  hash(password: string, cost: number): Promise<string>;
  compare(password: string, hash: string): Promise<boolean>;
}

export interface BcryptCapacityBudget {
  maxConcurrency: 1 | 4 | 8;
  minHashThroughputPerSecond: number;
  minCompareThroughputPerSecond: number;
  maxEventLoopDelayP95Ms: number;
  maxRssDeltaBytes: number;
  maxBatchDurationMs: number;
}

export interface LatencySummary {
  count: number;
  medianMs: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
}

export interface BcryptCapacityMeasurement {
  concurrency: 1 | 4 | 8;
  operationsPerKind: number;
  hashDurationMs: number;
  compareDurationMs: number;
  hashThroughputPerSecond: number;
  compareThroughputPerSecond: number;
  eventLoopDelayP95Ms: number;
  rssDeltaBytes: number;
}

export interface BcryptCostCalibration {
  cost: number;
  hash: LatencySummary;
  compare: LatencySummary;
  latencyGatePassed: boolean;
  capacity: BcryptCapacityMeasurement[];
  capacityGatePassed: boolean | null;
}

export interface BcryptCalibrationReport {
  schemaVersion: 1;
  warmupsPerCost: number;
  samplesPerKind: number;
  concurrencyLevels: readonly [1, 4, 8];
  capacityBudget: BcryptCapacityBudget | null;
  costs: BcryptCostCalibration[];
  selectedCost: number | null;
}

export interface BcryptCalibrationOptions {
  costs?: readonly number[];
  warmupsPerCost?: number;
  samplesPerKind?: number;
  concurrencyLevels?: readonly [1, 4, 8];
  capacityBudget?: BcryptCapacityBudget | null;
  latencyGate?: Readonly<{ medianMinMs: number; medianMaxMs: number; p95MaxMs: number }>;
}

const DEFAULT_COSTS = [10, 11, 12, 13, 14] as const;
const DEFAULT_CONCURRENCY = [1, 4, 8] as const;
const DEFAULT_LATENCY_GATE = { medianMinMs: 200, medianMaxMs: 350, p95MaxMs: 500 } as const;
const CALIBRATION_PASSWORD = 'SceneBoard calibration passphrase 2026';

const rounded = (value: number): number => Math.round(value * 1_000) / 1_000;

export const summarizeLatency = (samples: readonly number[]): LatencySummary => {
  if (samples.length === 0 || samples.some((sample) => !Number.isFinite(sample) || sample < 0)) {
    throw new TypeError('latency samples must be finite non-negative values');
  }
  const values = [...samples].sort((left, right) => left - right);
  const percentile = (ratio: number): number => values[Math.max(0, Math.ceil(values.length * ratio) - 1)]!;
  const median = values.length % 2 === 0
    ? (values[values.length / 2 - 1]! + values[values.length / 2]!) / 2
    : values[Math.floor(values.length / 2)]!;
  return {
    count: values.length,
    medianMs: rounded(median),
    p95Ms: rounded(percentile(0.95)),
    p99Ms: rounded(percentile(0.99)),
    maxMs: rounded(values[values.length - 1]!),
  };
};

const timed = async <Value>(operation: () => Promise<Value>): Promise<{ value: Value; durationMs: number }> => {
  const startedAt = performance.now();
  const value = await operation();
  return { value, durationMs: performance.now() - startedAt };
};

const runBounded = async (count: number, concurrency: number, operation: () => Promise<void>): Promise<void> => {
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < count) {
      cursor += 1;
      await operation();
    }
  };
  await Promise.all(Array.from({ length: Math.min(count, concurrency) }, worker));
};

const measureCapacity = async (
  adapter: BcryptCalibrationAdapter,
  cost: number,
  referenceHash: string,
  samplesPerKind: number,
  concurrency: 1 | 4 | 8,
): Promise<BcryptCapacityMeasurement> => {
  const rssBefore = process.memoryUsage().rss;
  const delay = monitorEventLoopDelay({ resolution: 10 });
  delay.enable();
  const hashStartedAt = performance.now();
  await runBounded(samplesPerKind, concurrency, async () => {
    await adapter.hash(CALIBRATION_PASSWORD, cost);
  });
  const hashDurationMs = performance.now() - hashStartedAt;
  const compareStartedAt = performance.now();
  await runBounded(samplesPerKind, concurrency, async () => {
    if (!await adapter.compare(CALIBRATION_PASSWORD, referenceHash)) throw new Error('bcrypt calibration compare failed');
  });
  const compareDurationMs = performance.now() - compareStartedAt;
  delay.disable();
  return {
    concurrency,
    operationsPerKind: samplesPerKind,
    hashDurationMs: rounded(hashDurationMs),
    compareDurationMs: rounded(compareDurationMs),
    hashThroughputPerSecond: rounded(samplesPerKind / Math.max(hashDurationMs / 1_000, 0.000_001)),
    compareThroughputPerSecond: rounded(samplesPerKind / Math.max(compareDurationMs / 1_000, 0.000_001)),
    eventLoopDelayP95Ms: rounded(Number(delay.percentile(95)) / 1_000_000),
    rssDeltaBytes: Math.max(0, process.memoryUsage().rss - rssBefore),
  };
};

const validateBudget = (budget: BcryptCapacityBudget): void => {
  if (!DEFAULT_CONCURRENCY.includes(budget.maxConcurrency)) throw new TypeError('capacity maxConcurrency must be 1, 4, or 8');
  for (const [key, value] of Object.entries(budget)) {
    if (key === 'maxConcurrency') continue;
    if (!Number.isFinite(value) || value <= 0) throw new TypeError(`capacity budget ${key} must be positive`);
  }
};

const capacityPasses = (
  measurements: readonly BcryptCapacityMeasurement[],
  budget: BcryptCapacityBudget,
): boolean => {
  const measurement = measurements.find((candidate) => candidate.concurrency === budget.maxConcurrency);
  if (measurement === undefined) return false;
  return measurement.hashThroughputPerSecond >= budget.minHashThroughputPerSecond
    && measurement.compareThroughputPerSecond >= budget.minCompareThroughputPerSecond
    && measurement.eventLoopDelayP95Ms <= budget.maxEventLoopDelayP95Ms
    && measurement.rssDeltaBytes <= budget.maxRssDeltaBytes
    && Math.max(measurement.hashDurationMs, measurement.compareDurationMs) <= budget.maxBatchDurationMs;
};

export const calibrateBcrypt = async (
  adapter: BcryptCalibrationAdapter,
  options: BcryptCalibrationOptions = {},
): Promise<BcryptCalibrationReport> => {
  const costs = options.costs ?? DEFAULT_COSTS;
  const warmups = options.warmupsPerCost ?? 3;
  const samples = options.samplesPerKind ?? 20;
  const concurrencyLevels = options.concurrencyLevels ?? DEFAULT_CONCURRENCY;
  const budget = options.capacityBudget ?? null;
  const latencyGate = options.latencyGate ?? DEFAULT_LATENCY_GATE;
  if (costs.length === 0 || costs.some((cost) => !Number.isInteger(cost) || cost < 10 || cost > 14)) {
    throw new TypeError('bcrypt calibration costs must be integers from 10 through 14');
  }
  if (!Number.isInteger(warmups) || warmups < 3) throw new TypeError('bcrypt calibration requires at least three warmups per cost');
  if (!Number.isInteger(samples) || samples < 20) throw new TypeError('bcrypt calibration requires at least twenty samples per kind');
  if (budget !== null) validateBudget(budget);

  const results: BcryptCostCalibration[] = [];
  for (const cost of costs) {
    let referenceHash = '';
    for (let index = 0; index < warmups; index += 1) {
      referenceHash = await adapter.hash(CALIBRATION_PASSWORD, cost);
      if (!await adapter.compare(CALIBRATION_PASSWORD, referenceHash)) throw new Error('bcrypt calibration warmup failed');
    }
    const hashSamples: number[] = [];
    const compareSamples: number[] = [];
    for (let index = 0; index < samples; index += 1) {
      const measured = await timed(() => adapter.hash(CALIBRATION_PASSWORD, cost));
      hashSamples.push(measured.durationMs);
    }
    for (let index = 0; index < samples; index += 1) {
      const measured = await timed(() => adapter.compare(CALIBRATION_PASSWORD, referenceHash));
      if (!measured.value) throw new Error('bcrypt calibration compare failed');
      compareSamples.push(measured.durationMs);
    }
    const hash = summarizeLatency(hashSamples);
    const compare = summarizeLatency(compareSamples);
    const latencyGatePassed = hash.medianMs >= latencyGate.medianMinMs
      && hash.medianMs <= latencyGate.medianMaxMs
      && hash.p95Ms < latencyGate.p95MaxMs;
    const capacity: BcryptCapacityMeasurement[] = [];
    if (latencyGatePassed) {
      for (const concurrency of concurrencyLevels) {
        capacity.push(await measureCapacity(adapter, cost, referenceHash, samples, concurrency));
      }
    }
    results.push({
      cost,
      hash,
      compare,
      latencyGatePassed,
      capacity,
      capacityGatePassed: budget === null || !latencyGatePassed ? null : capacityPasses(capacity, budget),
    });
  }
  const selected = results.find((result) => result.latencyGatePassed && result.capacityGatePassed === true);
  return {
    schemaVersion: 1,
    warmupsPerCost: warmups,
    samplesPerKind: samples,
    concurrencyLevels,
    capacityBudget: budget,
    costs: results,
    selectedCost: selected?.cost ?? null,
  };
};
