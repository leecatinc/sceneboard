import type { ArtifactBridgeMessageV1 } from './envelope.js';

const CHARGED_AUTHORED_TYPES = new Set<ArtifactBridgeMessageV1['type']>([
  'artifact.ready',
  'artifact.resize.request',
  'artifact.selection.change',
  'artifact.user-action',
  'artifact.capability.request',
]);

export const isChargedAuthoredMessageV1 = (message: Pick<ArtifactBridgeMessageV1, 'type'>): boolean => {
  return CHARGED_AUTHORED_TYPES.has(message.type);
};

export type ArtifactRateBudgetInputV1 = Readonly<{
  countRate: number;
  countBurst: number;
  byteRate: number;
  byteBurst: number;
  now?: () => number;
}>;

export class ArtifactRateBudgetV1 {
  readonly #input: ArtifactRateBudgetInputV1;
  #countTokens: number;
  #byteTokens: number;
  #lastTime: number;

  constructor(input: ArtifactRateBudgetInputV1) {
    this.#input = input;
    this.#countTokens = input.countBurst;
    this.#byteTokens = input.byteBurst;
    this.#lastTime = this.#readTime();
  }

  admit(byteLength: number): boolean {
    if (!Number.isInteger(byteLength) || byteLength < 0) return false;
    const now = this.#readTime();
    if (now < this.#lastTime) throw new TypeError('rate budget clock moved backward');
    const elapsed = Math.max(0, now - this.#lastTime);
    const nextCount = Math.min(this.#input.countBurst, this.#countTokens + elapsed * this.#input.countRate / 1000);
    const nextBytes = Math.min(this.#input.byteBurst, this.#byteTokens + elapsed * this.#input.byteRate / 1000);
    this.#lastTime = now;
    this.#countTokens = nextCount;
    this.#byteTokens = nextBytes;
    if (nextCount < 1 || nextBytes < byteLength) return false;
    this.#countTokens -= 1;
    this.#byteTokens -= byteLength;
    return true;
  }

  #readTime(): number {
    const value = (this.#input.now ?? (() => performance.now()))();
    if (!Number.isFinite(value) || value < 0) throw new TypeError('rate budget clock is invalid');
    return value;
  }
}
