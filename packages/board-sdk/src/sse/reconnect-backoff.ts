const RETRY_BASES_MS = [500, 1_000, 2_000, 4_000, 8_000, 15_000] as const;

export const reconnectBackoffMsV1 = (attempt: number, random = Math.random): number => {
  if (!Number.isSafeInteger(attempt) || attempt < 1)
    throw new TypeError('attempt must be a positive safe integer');
  const base = RETRY_BASES_MS[Math.min(attempt, RETRY_BASES_MS.length) - 1] ?? 15_000;
  const sample = random();
  if (!Number.isFinite(sample) || sample < 0 || sample >= 1)
    throw new TypeError('random sample must be in [0, 1)');
  return Math.floor(sample * (base + 1));
};

export const plannedRecycleJitterMsV1 = (random = Math.random): number => {
  const sample = random();
  if (!Number.isFinite(sample) || sample < 0 || sample >= 1)
    throw new TypeError('random sample must be in [0, 1)');
  return 100 + Math.floor(sample * 201);
};
