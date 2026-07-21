const JSON_WHITESPACE = new Set([' ', '\t', '\n', '\r']);
const FORBIDDEN_D2_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

export type StrictJsonErrorReason =
  | 'body_required'
  | 'payload_too_large'
  | 'invalid_utf8'
  | 'invalid_json'
  | 'duplicate_key'
  | 'forbidden_key'
  | 'depth_exceeded'
  | 'non_finite_number';

export class StrictJsonError extends Error {
  readonly reason: StrictJsonErrorReason;
  readonly offset: number | null;

  constructor(reason: StrictJsonErrorReason, offset: number | null = null) {
    super('Invalid JSON payload');
    this.name = 'StrictJsonError';
    this.reason = reason;
    this.offset = offset;
  }
}

class StrictJsonParser {
  private index = 0;

  constructor(
    private readonly source: string,
    private readonly maximumDepth: number,
  ) {}

  parse(): unknown {
    this.skipWhitespace();
    if (this.index === this.source.length) throw new StrictJsonError('body_required', this.index);
    const value = this.parseValue(1);
    this.skipWhitespace();
    if (this.index !== this.source.length) throw new StrictJsonError('invalid_json', this.index);
    return value;
  }

  private parseValue(depth: number): unknown {
    const token = this.source[this.index];
    if (token === '{') return this.parseObject(depth);
    if (token === '[') return this.parseArray(depth);
    if (token === '"') return this.parseString();
    if (token === 't') return this.parseLiteral('true', true);
    if (token === 'f') return this.parseLiteral('false', false);
    if (token === 'n') return this.parseLiteral('null', null);
    if (token === '-' || (token !== undefined && token >= '0' && token <= '9'))
      return this.parseNumber();
    throw new StrictJsonError('invalid_json', this.index);
  }

  private assertContainerDepth(depth: number): void {
    if (depth > this.maximumDepth) throw new StrictJsonError('depth_exceeded', this.index);
  }

  private parseObject(depth: number): Record<string, unknown> {
    this.assertContainerDepth(depth);
    this.index += 1;
    const result = Object.create(null) as Record<string, unknown>;
    const keys = new Set<string>();
    this.skipWhitespace();
    if (this.source[this.index] === '}') {
      this.index += 1;
      return result;
    }
    while (true) {
      if (this.source[this.index] !== '"') throw new StrictJsonError('invalid_json', this.index);
      const keyOffset = this.index;
      const key = this.parseString();
      if (FORBIDDEN_D2_KEYS.has(key)) throw new StrictJsonError('forbidden_key', keyOffset);
      if (keys.has(key)) throw new StrictJsonError('duplicate_key', keyOffset);
      keys.add(key);
      this.skipWhitespace();
      if (this.source[this.index] !== ':') throw new StrictJsonError('invalid_json', this.index);
      this.index += 1;
      this.skipWhitespace();
      result[key] = this.parseValue(depth + 1);
      this.skipWhitespace();
      const delimiter = this.source[this.index];
      if (delimiter === '}') {
        this.index += 1;
        return result;
      }
      if (delimiter !== ',') throw new StrictJsonError('invalid_json', this.index);
      this.index += 1;
      this.skipWhitespace();
    }
  }

  private parseArray(depth: number): unknown[] {
    this.assertContainerDepth(depth);
    this.index += 1;
    const result: unknown[] = [];
    this.skipWhitespace();
    if (this.source[this.index] === ']') {
      this.index += 1;
      return result;
    }
    while (true) {
      result.push(this.parseValue(depth + 1));
      this.skipWhitespace();
      const delimiter = this.source[this.index];
      if (delimiter === ']') {
        this.index += 1;
        return result;
      }
      if (delimiter !== ',') throw new StrictJsonError('invalid_json', this.index);
      this.index += 1;
      this.skipWhitespace();
    }
  }

  private parseString(): string {
    const start = this.index;
    this.index += 1;
    let value = '';
    while (this.index < this.source.length) {
      const character = this.source[this.index];
      if (character === '"') {
        this.index += 1;
        return value;
      }
      if (character === undefined || character.charCodeAt(0) < 0x20) {
        throw new StrictJsonError('invalid_json', this.index);
      }
      if (character !== '\\') {
        value += character;
        this.index += 1;
        continue;
      }
      this.index += 1;
      const escaped = this.source[this.index];
      if (escaped === undefined) throw new StrictJsonError('invalid_json', this.index);
      const simpleEscape: Record<string, string> = {
        '"': '"',
        '\\': '\\',
        '/': '/',
        b: '\b',
        f: '\f',
        n: '\n',
        r: '\r',
        t: '\t',
      };
      if (Object.hasOwn(simpleEscape, escaped)) {
        value += simpleEscape[escaped];
        this.index += 1;
        continue;
      }
      if (escaped !== 'u') throw new StrictJsonError('invalid_json', this.index);
      const hex = this.source.slice(this.index + 1, this.index + 5);
      if (!/^[0-9A-Fa-f]{4}$/.test(hex)) throw new StrictJsonError('invalid_json', this.index);
      value += String.fromCharCode(Number.parseInt(hex, 16));
      this.index += 5;
    }
    throw new StrictJsonError('invalid_json', start);
  }

  private parseNumber(): number {
    const source = this.source.slice(this.index);
    const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(source);
    if (!match) throw new StrictJsonError('invalid_json', this.index);
    const number = Number(match[0]);
    if (!Number.isFinite(number)) throw new StrictJsonError('non_finite_number', this.index);
    this.index += match[0].length;
    return number;
  }

  private parseLiteral<Value>(literal: string, value: Value): Value {
    if (!this.source.startsWith(literal, this.index))
      throw new StrictJsonError('invalid_json', this.index);
    this.index += literal.length;
    return value;
  }

  private skipWhitespace(): void {
    while (this.index < this.source.length && JSON_WHITESPACE.has(this.source[this.index] ?? ''))
      this.index += 1;
  }
}

export interface StrictJsonOptions {
  maximumBytes?: number;
  maximumDepth?: number;
}

export const parseStrictJsonBytes = (
  bytes: Uint8Array,
  options: StrictJsonOptions = {},
): unknown => {
  const maximumBytes = options.maximumBytes ?? 65_536;
  const maximumDepth = options.maximumDepth ?? 32;
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1)
    throw new TypeError('maximumBytes must be positive');
  if (!Number.isSafeInteger(maximumDepth) || maximumDepth < 1)
    throw new TypeError('maximumDepth must be positive');
  if (bytes.byteLength === 0) throw new StrictJsonError('body_required', 0);
  if (bytes.byteLength > maximumBytes) throw new StrictJsonError('payload_too_large', maximumBytes);
  let source: string;
  try {
    source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new StrictJsonError('invalid_utf8', null);
  }
  return new StrictJsonParser(source, maximumDepth).parse();
};
