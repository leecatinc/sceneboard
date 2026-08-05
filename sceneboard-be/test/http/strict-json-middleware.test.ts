import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { test } from 'node:test';

import {
  D1_PARSED_BODY,
  D1_RAW_BODY,
  SCENEBOARD_RAW_BINARY_BODY,
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

test('attaches strict D2 bodies for share, invitation, and member management routes', async () => {
  for (const [method, url, value] of [
    [
      'POST',
      '/api/v1/boards/AAECAwQFBgcICQoLDA0ODw/shares',
      { pinnedRevisionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
    ],
    [
      'POST',
      '/api/v1/boards/AAECAwQFBgcICQoLDA0ODw/invitations',
      { email: 'qa@example.com', role: 'viewer' },
    ],
    [
      'PATCH',
      '/api/v1/boards/AAECAwQFBgcICQoLDA0ODw/members/AAECAwQFBgcICQoLDA0ODw',
      { role: 'editor', version: 1 },
    ],
  ] as const) {
    const source = JSON.stringify(value);
    const input = request(method, url, source, {
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(source)),
    });
    assert.equal(await run(input), undefined);
    assert.equal(JSON.stringify(input.body), source);
    assert.equal(Object.getPrototypeOf(input.body), null);
  }
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

test('selects the isolated V2 document media profile and preserves the nested shared request', async () => {
  const source = JSON.stringify({
    protocolVersion: 1,
    requestId: 'request_document_1',
    idempotencyKey: '0123456789abcdef',
    boardId: 'AAECAwQFBgcICQoLDA0ODw',
    expectedRevisionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    command: {
      type: 'document.replace',
      document: {
        schemaVersion: 2,
        defaultPageId: 'page_1',
        pages: [
          {
            pageId: 'page_1',
            title: '',
            displayMode: 'fit-page',
            scene: { protocolVersion: 1, type: 'scene', root: null },
          },
        ],
      },
    },
  });
  const input = request('POST', '/api/v1/boards/AAECAwQFBgcICQoLDA0ODw/mutations', source, {
    'content-type': 'application/vnd.sceneboard.document+json;version=2',
    'content-encoding': 'identity',
    'content-length': String(Buffer.byteLength(source)),
  });
  assert.equal(await run(input), undefined);
  const profiled = input as typeof input & Record<symbol, unknown>;
  assert.deepEqual(profiled[D1_RAW_BODY], Buffer.from(source));
  assert.equal(
    (profiled[D1_PARSED_BODY] as { command?: { type?: string } }).command?.type,
    'document.replace',
  );
});

test('selects the V3 document media profile used by document format changes', async () => {
  const source = JSON.stringify({
    protocolVersion: 1,
    requestId: 'request_document_3',
    idempotencyKey: '0123456789abcdef',
    boardId: 'AAECAwQFBgcICQoLDA0ODw',
    expectedRevisionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    command: {
      type: 'document.replace',
      document: {
        schemaVersion: 3,
        format: 'standard_4_3',
        defaultPageId: 'page_1',
        pages: [
          {
            pageId: 'page_1',
            title: '',
            displayMode: 'fit-page',
            scene: { protocolVersion: 1, type: 'scene', root: null },
          },
        ],
      },
    },
  });
  const input = request(
    'POST',
    '/api/v1/boards/AAECAwQFBgcICQoLDA0ODw/mutations?documentSchemaVersion=3',
    source,
    {
      'content-type': 'application/vnd.sceneboard.document+json;version=3',
      'content-encoding': 'identity',
      'content-length': String(Buffer.byteLength(source)),
    },
  );
  assert.equal(await run(input), undefined);
  const profiled = input as typeof input & Record<symbol, unknown>;
  assert.equal(
    (profiled[D1_PARSED_BODY] as { command?: { document?: { format?: string } } }).command?.document
      ?.format,
    'standard_4_3',
  );
});

test('rejects unsupported V2 content encoding before consuming request bytes', async () => {
  let reads = 0;
  const input = {
    method: 'POST',
    url: '/api/v1/boards/AAECAwQFBgcICQoLDA0ODw/mutations',
    headers: {
      'content-type': 'application/vnd.sceneboard.document+json;version=2',
      'content-encoding': 'gzip',
    },
    async *[Symbol.asyncIterator]() {
      reads += 1;
      yield Buffer.from('{}');
    },
  };
  let nextValue: unknown;
  await new StrictJsonBodyMiddleware().use(input as never, {}, (value?: unknown) => {
    nextValue = value;
  });
  assert.ok(nextValue instanceof Error);
  assert.equal(reads, 0);
});

test('is the sole media stream consumer and attaches only verified binary bytes', async () => {
  const source = Buffer.from('89504e470d0a1a0a00000000', 'hex');
  const digest = createHash('sha256').update(source).digest('base64');
  const input = request(
    'POST',
    '/api/v1/boards/board_1/media?requestId=request_media_1',
    source.toString('latin1'),
    {
      'content-type': 'image/png',
      'content-length': String(source.byteLength),
      'content-digest': `sha-256=:${digest}:`,
    },
  );
  input.removeAllListeners();
  const exact = Object.assign(Readable.from([source]), {
    method: input.method,
    url: input.url,
    headers: input.headers,
  });
  assert.equal(await run(exact as ReturnType<typeof request>), undefined);
  assert.deepEqual(
    (exact as typeof exact & Record<symbol, unknown>)[SCENEBOARD_RAW_BINARY_BODY],
    source,
  );
});

test('rejects an unsupported media type before consuming binary bytes', async () => {
  let reads = 0;
  const source = Buffer.from('89504e470d0a1a0a', 'hex');
  const input = {
    method: 'POST',
    url: '/api/v1/boards/board_1/media?requestId=request_media_1',
    headers: {
      'content-type': 'application/json',
      'content-length': String(source.byteLength),
      'content-digest': `sha-256=:${createHash('sha256').update(source).digest('base64')}:`,
    },
    async *[Symbol.asyncIterator]() {
      reads += 1;
      yield source;
    },
  };
  let nextValue: unknown;
  await new StrictJsonBodyMiddleware().use(input as never, {}, (value?: unknown) => {
    nextValue = value;
  });
  assert.ok(nextValue instanceof Error);
  assert.equal(reads, 0);
});

test('bounds advertised and lying media senders before closing their connection', async () => {
  const digest = `sha-256=:${Buffer.alloc(32).toString('base64')}:`;
  let advertisedReads = 0;
  const advertisedHeaders: Record<string, string> = {};
  const advertised = {
    method: 'POST',
    url: '/api/v1/boards/board_1/media?requestId=request_media_1',
    headers: {
      'content-type': 'image/png',
      'content-length': '10485761',
      'content-digest': digest,
    },
    async *[Symbol.asyncIterator]() {
      advertisedReads += 1;
      yield Buffer.alloc(1);
    },
  };
  let advertisedError: unknown;
  await new StrictJsonBodyMiddleware().use(
    advertised as never,
    {
      setHeader(name: string, value: string) {
        advertisedHeaders[name] = value;
      },
    },
    (value?: unknown) => {
      advertisedError = value;
    },
  );
  assert.ok(advertisedError instanceof Error);
  assert.equal(advertisedReads, 0);
  assert.equal(advertisedHeaders.Connection, 'close');

  let paused = false;
  let destroyed = false;
  const terminal: Array<() => void> = [];
  const lying = {
    method: 'POST',
    url: '/api/v1/boards/board_1/media?requestId=request_media_1',
    headers: {
      'content-type': 'image/png',
      'content-length': '10485760',
      'content-digest': digest,
    },
    pause() {
      paused = true;
    },
    destroy() {
      destroyed = true;
    },
    async *[Symbol.asyncIterator]() {
      yield Buffer.alloc(10_485_760);
      yield Buffer.alloc(1);
    },
  };
  let lyingError: unknown;
  await new StrictJsonBodyMiddleware().use(
    lying as never,
    {
      setHeader() {},
      once(_event: 'finish' | 'close', callback: () => void) {
        terminal.push(callback);
      },
    },
    (value?: unknown) => {
      lyingError = value;
    },
  );
  assert.ok(lyingError instanceof Error);
  assert.equal(paused, true);
  assert.equal(destroyed, false);
  terminal[0]?.();
  assert.equal(destroyed, true);
});
