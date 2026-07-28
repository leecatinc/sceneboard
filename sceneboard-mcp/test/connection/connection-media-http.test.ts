import assert from 'node:assert/strict';
import test from 'node:test';

import { ConnectionMediaHttpClientV1 } from '../../src/connection/connection-media-http.client.js';

const mediaResult = {
  protocolVersion: 1 as const,
  type: 'media.ingest.result' as const,
  requestId: 'request_media_1',
  status: 'created' as const,
  media: {
    mediaId: 'media_1' as never,
    sha256: 'a'.repeat(64),
    mime: 'image/png' as const,
    width: 10,
    height: 10,
    bytes: 8,
  },
};

const response = (requestId = 'request_media_1') =>
  new Response(
    JSON.stringify({
      protocolVersion: 1,
      type: 'board.http.success',
      requestId,
      result: mediaResult,
    }),
    {
      status: 201,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'X-Request-Id': requestId,
      },
    },
  );

test('sends one exact bearer binary attempt and accepts only triple-correlated success', async () => {
  let observed: { url: URL; init: RequestInit } | null = null;
  const client = new ConnectionMediaHttpClientV1({
    baseUrl: 'https://sceneboard.dev',
    timeoutMs: 1_000,
    logger: { log() {} },
    fetch: async (input, init) => {
      observed = { url: new URL(String(input)), init: init ?? {} };
      return response();
    },
  });
  const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const result = await client.upload({
    boardId: 'board_1',
    requestId: 'request_media_1',
    idempotencyKey: 'idempotency-key-1',
    accessToken: 'token-secret',
    mime: 'image/png',
    digestBase64: 'digest',
    bytes,
  });
  assert.equal(result.ok, true);
  assert.notEqual(observed, null);
  const request = observed as unknown as { url: URL; init: RequestInit };
  assert.equal(request.url.pathname, '/api/v1/boards/board_1/media');
  assert.equal(request.url.search, '?requestId=request_media_1');
  assert.equal(request.init.method, 'POST');
  assert.equal(request.init.redirect, 'manual');
  const headers = new Headers(request.init.headers);
  assert.equal(headers.get('authorization'), 'Bearer token-secret');
  assert.equal(headers.get('content-type'), 'image/png');
  assert.equal(headers.get('content-length'), '8');
  assert.equal(headers.get('content-digest'), 'sha-256=:digest:');
  assert.equal(headers.get('idempotency-key'), 'idempotency-key-1');
  for (const forbidden of ['cookie', 'origin', 'x-csrf-token', 'x-request-id'])
    assert.equal(headers.has(forbidden), false);
  assert.equal(request.init.body, bytes);
});

test('rejects a response header, outer, or nested request correlation drift', async () => {
  const cases = [
    () => response('other_request'),
    () =>
      new Response(
        JSON.stringify({
          protocolVersion: 1,
          type: 'board.http.success',
          requestId: 'other_request',
          result: mediaResult,
        }),
        {
          status: 201,
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'X-Request-Id': 'request_media_1',
          },
        },
      ),
    () =>
      new Response(
        JSON.stringify({
          protocolVersion: 1,
          type: 'board.http.success',
          requestId: 'request_media_1',
          result: { ...mediaResult, requestId: 'other_request' },
        }),
        {
          status: 201,
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'X-Request-Id': 'request_media_1',
          },
        },
      ),
  ];
  for (const makeResponse of cases) {
    const client = new ConnectionMediaHttpClientV1({
      baseUrl: 'https://sceneboard.dev',
      timeoutMs: 1_000,
      logger: { log() {} },
      fetch: async () => makeResponse(),
    });
    const result = await client.upload({
      boardId: 'board_1',
      requestId: 'request_media_1',
      idempotencyKey: 'idempotency-key-1',
      accessToken: 'token-secret',
      mime: 'image/png',
      digestBase64: 'digest',
      bytes: Buffer.alloc(8),
    });
    assert.deepEqual(result, {
      ok: false,
      error: { code: 'RESPONSE_INVALID', retryable: false, reason: 'correlation' },
    });
  }
});
