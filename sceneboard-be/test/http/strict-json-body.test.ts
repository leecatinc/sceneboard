import assert from 'node:assert/strict';
import { test } from 'node:test';

import { StrictJsonError, parseStrictJsonBytes } from '../../src/common/http/strict-json.js';

const encode = (value: string): Uint8Array => new TextEncoder().encode(value);

test('materializes strict JSON objects with null prototypes', () => {
  const value = parseStrictJsonBytes(
    encode('{"email":"dev@sceneboard.dev","nested":{"ok":true}}'),
  ) as Record<string, unknown>;
  assert.equal(Object.getPrototypeOf(value), null);
  assert.equal(Object.getPrototypeOf(value.nested), null);
  assert.deepEqual(Object.keys(value), ['email', 'nested']);
});

test('rejects decoded duplicate names and D2 special keys at every depth', () => {
  const invalid = [
    '{"a":1,"a":2}',
    '{"a":1,"\\u0061":2}',
    '{"__proto__":1}',
    '{"safe":{"prototype":1}}',
    '{"constructor":1}',
  ];
  for (const source of invalid)
    assert.throws(() => parseStrictJsonBytes(encode(source)), StrictJsonError, source);
});

test('enforces D2 byte, depth, UTF-8, number, and trailing-input bounds', () => {
  const atDepth = `${'['.repeat(32)}0${']'.repeat(32)}`;
  assert.doesNotThrow(() => parseStrictJsonBytes(encode(atDepth)));
  const overDepth = `${'['.repeat(33)}0${']'.repeat(33)}`;
  assert.throws(() => parseStrictJsonBytes(encode(overDepth)), StrictJsonError);

  const body = `${' '.repeat(65_534)}{}`;
  assert.equal(encode(body).byteLength, 65_536);
  assert.doesNotThrow(() => parseStrictJsonBytes(encode(body)));
  assert.throws(() => parseStrictJsonBytes(encode(` ${body}`)), StrictJsonError);
  assert.throws(() => parseStrictJsonBytes(new Uint8Array([0xc3, 0x28])), StrictJsonError);
  assert.throws(() => parseStrictJsonBytes(encode('{"n":1e400}')), StrictJsonError);
  assert.throws(() => parseStrictJsonBytes(encode('{} trailing')), StrictJsonError);
  assert.throws(() => parseStrictJsonBytes(encode('')), StrictJsonError);
});
