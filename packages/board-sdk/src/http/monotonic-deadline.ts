export type MonotonicDeadlineV1 = {
  signal: AbortSignal;
  remainingMs(): number;
  timedOut(): boolean;
  dispose(): void;
};

export const createMonotonicDeadlineV1 = (
  timeoutMs: number,
  outerSignal?: AbortSignal,
): MonotonicDeadlineV1 => {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new TypeError('timeoutMs must be a positive safe integer');
  }
  const startedAt = performance.now();
  const controller = new AbortController();
  let timeoutReached = false;
  const onOuterAbort = (): void => controller.abort(outerSignal?.reason);
  if (outerSignal?.aborted) onOuterAbort();
  else outerSignal?.addEventListener('abort', onOuterAbort, { once: true });
  const timer = setTimeout(() => {
    timeoutReached = true;
    controller.abort(new DOMException('Deadline exceeded', 'TimeoutError'));
  }, timeoutMs);
  const remainingMs = (): number => Math.max(0, timeoutMs - (performance.now() - startedAt));
  const dispose = (): void => {
    clearTimeout(timer);
    outerSignal?.removeEventListener('abort', onOuterAbort);
  };
  return { signal: controller.signal, remainingMs, timedOut: () => timeoutReached, dispose };
};
