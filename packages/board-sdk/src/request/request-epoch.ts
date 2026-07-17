export class RequestEpochV1 {
  #value = 0;
  #active = true;

  capture(): number {
    return this.#value;
  }

  isCurrent(value: number): boolean {
    return this.#active && value === this.#value;
  }

  advance(): number {
    if (!this.#active) throw new TypeError('request epoch is closed');
    this.#value += 1;
    if (!Number.isSafeInteger(this.#value)) throw new RangeError('request epoch exhausted');
    return this.#value;
  }

  close(): void {
    this.#active = false;
    this.#value += 1;
  }
}
