import type { ArtifactBridgeMessageV1 } from './envelope.js';

const nativeNumberIsFinite = Number.isFinite;
const nativeNumberMaxSafeInteger = Number.MAX_SAFE_INTEGER;
const nativeMathMax = Math.max;
const nativeMathMin = Math.min;

type NavigationMessageV1 = Extract<ArtifactBridgeMessageV1, { type: `artifact.navigation.${string}` }>;
type PanTerminalV1 = 'end' | 'cancel' | null;

export type ArtifactNavigationSchedulerInputV1 = Readonly<{
  now(): number;
  schedule(callback: () => void, delayMs: number): unknown;
  cancel(handle: unknown): void;
  emit(message: NavigationMessageV1): void;
}>;

export class ArtifactNavigationSchedulerV1 {
  readonly #input: ArtifactNavigationSchedulerInputV1;
  #enabled = false;
  #timer: unknown = null;
  #lastSentAt = Number.NEGATIVE_INFINITY;
  #clockHighWater = Number.NEGATIVE_INFINITY;
  #wheel: Extract<NavigationMessageV1, { type: 'artifact.navigation.wheel' }> | null = null;
  #pan: {
    pointerId: number;
    xMillionth: number;
    yMillionth: number;
    startSent: boolean;
    deltaX: number;
    deltaY: number;
    terminal: PanTerminalV1;
  } | null = null;

  constructor(input: ArtifactNavigationSchedulerInputV1) {
    this.#input = input;
  }

  get hasPan(): boolean {
    return this.#pan !== null;
  }

  setEnabled(enabled: boolean): void {
    this.#enabled = enabled;
    if (enabled) return;
    this.#wheel = null;
    if (this.#pan === null) {
      this.#cancelTimer();
      return;
    }
    if (!this.#pan.startSent) {
      this.#pan = null;
      this.#cancelTimer();
      return;
    }
    this.#pan.deltaX = 0;
    this.#pan.deltaY = 0;
    this.#pan.terminal = 'cancel';
    this.#arm();
  }

  wheel(message: Extract<NavigationMessageV1, { type: 'artifact.navigation.wheel' }>): void {
    if (!this.#enabled) return;
    if (this.#wheel === null) {
      this.#wheel = message;
    } else {
      const deltaY = this.#boundedTotal(this.#wheel.deltaY, message.deltaY);
      this.#wheel = deltaY === 0 ? null : { ...message, deltaY };
    }
    this.#arm();
  }

  start(message: Extract<NavigationMessageV1, { type: 'artifact.navigation.pan.start' }>): boolean {
    if (!this.#enabled || this.#pan !== null) return false;
    this.#pan = {
      pointerId: message.pointerId,
      xMillionth: message.xMillionth,
      yMillionth: message.yMillionth,
      startSent: false,
      deltaX: 0,
      deltaY: 0,
      terminal: null,
    };
    this.#arm();
    return true;
  }

  move(pointerId: number, deltaX: number, deltaY: number): void {
    const pan = this.#pan;
    if (!this.#enabled || pan === null || pan.pointerId !== pointerId || pan.terminal !== null) return;
    pan.deltaX = this.#boundedTotal(pan.deltaX, deltaX);
    pan.deltaY = this.#boundedTotal(pan.deltaY, deltaY);
    this.#arm();
  }

  end(pointerId: number, deltaX: number, deltaY: number): void {
    const pan = this.#pan;
    if (!this.#enabled || pan === null || pan.pointerId !== pointerId || pan.terminal !== null) return;
    pan.deltaX = this.#boundedTotal(pan.deltaX, deltaX);
    pan.deltaY = this.#boundedTotal(pan.deltaY, deltaY);
    pan.terminal = 'end';
    this.#arm();
  }

  cancelPan(pointerId?: number): void {
    const pan = this.#pan;
    if (pan === null || (pointerId !== undefined && pan.pointerId !== pointerId)) return;
    if (!pan.startSent) {
      this.#pan = null;
      this.#arm();
      return;
    }
    pan.deltaX = 0;
    pan.deltaY = 0;
    pan.terminal = 'cancel';
    this.#arm();
  }

  dispose(): void {
    this.#enabled = false;
    this.#wheel = null;
    this.#pan = null;
    this.#cancelTimer();
  }

  #arm(): void {
    if (this.#timer !== null || !this.#hasPending()) return;
    const now = this.#readTime();
    const delay = nativeMathMax(0, 34 - (now - this.#lastSentAt));
    this.#timer = this.#input.schedule(() => this.#flush(), delay);
  }

  #flush(): void {
    this.#timer = null;
    const now = this.#readTime();
    const remaining = 34 - (now - this.#lastSentAt);
    if (remaining > 0) {
      this.#timer = this.#input.schedule(() => this.#flush(), remaining);
      return;
    }
    const message = this.#nextMessage();
    if (message === null) return;
    this.#input.emit(message);
    this.#lastSentAt = now;
    this.#arm();
  }

  #nextMessage(): NavigationMessageV1 | null {
    const pan = this.#pan;
    if (pan !== null) {
      if (!pan.startSent) {
        pan.startSent = true;
        return { type: 'artifact.navigation.pan.start', pointerId: pan.pointerId, xMillionth: pan.xMillionth, yMillionth: pan.yMillionth };
      }
      if (pan.terminal === 'cancel') {
        this.#pan = null;
        return { type: 'artifact.navigation.pan.cancel', pointerId: pan.pointerId };
      }
      const deltaX = this.#chunk(pan.deltaX, 16_384);
      const deltaY = this.#chunk(pan.deltaY, 16_384);
      pan.deltaX -= deltaX;
      pan.deltaY -= deltaY;
      if (pan.terminal === 'end' && pan.deltaX === 0 && pan.deltaY === 0) {
        this.#pan = null;
        return { type: 'artifact.navigation.pan.end', pointerId: pan.pointerId, deltaX, deltaY };
      }
      if (deltaX !== 0 || deltaY !== 0) return { type: 'artifact.navigation.pan.move', pointerId: pan.pointerId, deltaX, deltaY };
    }
    if (this.#pan !== null) return null;
    const wheel = this.#wheel;
    if (wheel === null) return null;
    const deltaY = this.#chunk(wheel.deltaY, 4_096);
    const remainder = wheel.deltaY - deltaY;
    this.#wheel = remainder === 0 ? null : { ...wheel, deltaY: remainder };
    return { ...wheel, deltaY };
  }

  #hasPending(): boolean {
    const pan = this.#pan;
    if (pan !== null) return !pan.startSent || pan.terminal !== null || pan.deltaX !== 0 || pan.deltaY !== 0;
    return this.#wheel !== null;
  }

  #cancelTimer(): void {
    if (this.#timer === null) return;
    this.#input.cancel(this.#timer);
    this.#timer = null;
  }

  #readTime(): number {
    const value = this.#input.now();
    if (!nativeNumberIsFinite(value) || value < 0) throw new TypeError('navigation clock is invalid');
    if (value < this.#clockHighWater) throw new TypeError('navigation clock moved backward');
    this.#clockHighWater = value;
    return value;
  }

  #boundedTotal(left: number, right: number): number {
    return nativeMathMax(-nativeNumberMaxSafeInteger, nativeMathMin(nativeNumberMaxSafeInteger, left + right));
  }

  #chunk(value: number, limit: number): number {
    return nativeMathMax(-limit, nativeMathMin(limit, value));
  }
}
