export const protectedRetryDelayMsV1 = (completedAttempt: number, random = Math.random): number => {
  if (completedAttempt !== 1 && completedAttempt !== 2) {
    throw new TypeError('completedAttempt must be 1 or 2');
  }
  const sample = random();
  if (!Number.isFinite(sample) || sample < 0 || sample >= 1) {
    throw new TypeError('random sample must be in [0, 1)');
  }
  return (completedAttempt === 1 ? 100 : 300) + Math.floor(sample * 51);
};

export const sleepWithinDeadlineV1 = async (
  milliseconds: number,
  remainingMs: () => number,
  signal: AbortSignal,
): Promise<boolean> => {
  if (
    !Number.isFinite(milliseconds) ||
    milliseconds < 0 ||
    milliseconds >= remainingMs() ||
    signal.aborted
  ) {
    return false;
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => done(true), milliseconds);
    const onAbort = (): void => done(false);
    const done = (completed: boolean): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve(completed);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
};
