export type HitlWaitKeyV1 = string;

type Waiter = {
  resolve: () => void;
  cleanup: () => void;
};

export class HitlWaitCoordinator {
  private readonly generations = new Map<HitlWaitKeyV1, number>();
  private readonly waiters = new Map<HitlWaitKeyV1, Set<Waiter>>();

  generation(key: HitlWaitKeyV1): number {
    return this.generations.get(key) ?? 0;
  }

  notify(key: HitlWaitKeyV1): void {
    this.generations.set(key, this.generation(key) + 1);
    const listeners = this.waiters.get(key);
    if (listeners === undefined) return;
    for (const waiter of [...listeners]) waiter.resolve();
  }

  wait(
    key: HitlWaitKeyV1,
    generation: number,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<void> {
    if (signal.aborted)
      return Promise.reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    if (this.generation(key) !== generation || timeoutMs <= 0) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const listeners = this.waiters.get(key) ?? new Set<Waiter>();
      const timer = setTimeout(() => waiter.resolve(), timeoutMs);
      const abort = (): void => {
        waiter.cleanup();
        reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      };
      const waiter: Waiter = {
        resolve: () => {
          waiter.cleanup();
          resolve();
        },
        cleanup: () => {
          clearTimeout(timer);
          signal.removeEventListener('abort', abort);
          listeners.delete(waiter);
          if (listeners.size === 0) this.waiters.delete(key);
        },
      };
      listeners.add(waiter);
      this.waiters.set(key, listeners);
      signal.addEventListener('abort', abort, { once: true });
      if (this.generation(key) !== generation) waiter.resolve();
    });
  }
}
