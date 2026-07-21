import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { test } from 'node:test';

import {
  D1_PARSED_BODY,
  D1_RAW_BODY,
  StrictJsonBodyMiddleware,
} from '../../src/common/http/strict-json-body.middleware.js';

const request = (
  method: string,
  url: string,
  source: string,
  headers: Record<string, string> = {},
) => {
  const stream = Readable.from(source === '' ? [] : [Buffer.from(source)]);
  return Object.assign(stream, { method, url, headers, body: undefined as unknown });
};

const run = async (input: ReturnType<typeof request>): Promise<unknown> => {
  let nextValue: unknown = Symbol('not-called');
  await new StrictJsonBodyMiddleware().use(input, {}, (value?: unknown) => {
    nextValue = value;
  });
  return nextValue;
};

test('reads and attaches one strict D2 body before downstream handlers', async () => {
  const input = request('POST', '/api/v1/auth/login', '{}', {
    'content-type': 'application/json',
    'content-length': '2',
  });
  assert.equal(await run(input), undefined);
  assert.equal(Object.getPrototypeOf(input.body), null);
});

test('retains D1 raw bytes and parsed contract on private symbols', async () => {
  const source =
    '{"protocolVersion":1,"requestId":"request_01","type":"board.create","title":"SceneBoard","idempotencyKey":"0123456789abcdef"}';
  const input = request('POST', '/api/v1/boards', source, {
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(source)),
  });
  assert.equal(await run(input), undefined);
  const profiled = input as typeof input & Record<symbol, unknown>;
  assert.deepEqual(profiled[D1_RAW_BODY], Buffer.from(source));
  assert.equal((profiled[D1_PARSED_BODY] as { type?: string }).type, 'board.create');
  assert.equal(input.body, undefined);
});

test('passes transport failures to next and performs no body attachment', async () => {
  const input = request('POST', '/api/v1/auth/login', '{}', { 'content-type': 'text/plain' });
  const result = await run(input);
  assert.ok(result instanceof Error);
  assert.equal(input.body, undefined);
});
