import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ArgumentsHost } from '@nestjs/common';

import { AppError, BoardContractError } from '../../src/common/errors/app-error.js';
import { invalidBoardPayload } from '../../src/common/errors/board-error.factory.js';
import { HttpErrorFilter } from '../../src/common/filters/http-error.filter.js';
import { ShareAnalyticsError } from '../../src/common/errors/share-analytics.error.js';
import { BOARD_REQUEST_ID } from '../../src/common/http/board-request-correlation.js';
import { CryptoService } from '../../src/common/security/crypto.service.js';

const key = Buffer.alloc(32, 1);
const crypto = new CryptoService(
  {
    sessionToken: key,
    grantToken: key,
    csrf: key,
    pairingCodePepper: key,
    auditHmac: key,
    rateLimitHmac: key,
  },
  (length) => Buffer.alloc(length, 2),
);

const capture = (
  error: unknown,
  request: { url?: string; [BOARD_REQUEST_ID]?: never } = {},
  responseState: { headersSent?: boolean; writableEnded?: boolean; destroyed?: boolean } = {},
) => {
  const headers = new Map<string, string>();
  let status = 0;
  let body: unknown;
  const response = {
    ...responseState,
    setHeader: (name: string, value: string) => headers.set(name, value),
    status: (value: number) => {
      status = value;
      return response;
    },
    json: (value: unknown) => {
      body = value;
      return response;
    },
  };
  const host = {
    switchToHttp: () => ({ getResponse: () => response, getRequest: () => request }),
  } as unknown as ArgumentsHost;
  new HttpErrorFilter(crypto).catch(error, host);
  return { status, body, headers };
};

test('wraps D2 errors once and emits only safe public fields', () => {
  const response = capture(new AppError('RATE_LIMITED', { retryAfterSeconds: 9 }), {
    url: '/api/v1/pairings/claim',
  });
  assert.equal(response.status, 429);
  assert.deepEqual(response.body, {
    error: { code: 'RATE_LIMITED', message: 'Too many requests' },
  });
  assert.equal(response.headers.get('Retry-After'), '9');
  assert.match(response.headers.get('X-Request-Id') ?? '', /^[A-Za-z0-9_-]{22}$/);
  assert.equal(response.headers.get('Cache-Control'), 'no-store, private');
  assert.equal(response.headers.get('Pragma'), 'no-cache');
  assert.equal(response.headers.has('Vary'), false);
});

test('nests the exact D1 board error without reshaping it', () => {
  const boardError = invalidBoardPayload('bad request');
  const response = capture(new BoardContractError(boardError));
  assert.equal(response.status, 400);
  assert.deepEqual(response.body, { error: boardError });
});

test('maps unknown exceptions to one generic internal error', () => {
  const response = capture(new Error('database password leaked'));
  assert.equal(response.status, 500);
  assert.deepEqual(response.body, {
    error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
  });
  assert.equal(JSON.stringify(response.body).includes('password leaked'), false);
});

test('maps board-bound infrastructure errors to D1 and preserves admitted correlation', () => {
  const request = {
    url: '/api/v1/boards/board_1',
    [BOARD_REQUEST_ID]: 'request_01' as never,
  };
  const response = capture(new AppError('SERVICE_UNAVAILABLE', { retryAfterSeconds: 4 }), request);
  assert.equal(response.status, 503);
  assert.deepEqual(response.body, {
    error: {
      protocolVersion: 1,
      type: 'board.error',
      code: 'SERVICE_UNAVAILABLE',
      message: 'Service unavailable',
      category: 'availability',
      retryable: true,
      httpStatusHint: 503,
      details: { retryAfterSeconds: 4 },
    },
  });
  assert.equal(response.headers.get('X-Request-Id'), 'request_01');
  assert.equal(response.headers.get('Retry-After'), '4');
});

test('preserves a valid query correlation when authentication rejects before the controller', () => {
  const response = capture(
    new BoardContractError({
      protocolVersion: 1,
      type: 'board.error',
      code: 'UNAUTHENTICATED',
      message: 'Authentication is required',
      category: 'auth',
      retryable: false,
      httpStatusHint: 401,
      details: null,
    }),
    { url: '/api/v1/mcp/connection?requestId=request_01' },
  );
  assert.equal(response.status, 401);
  assert.equal(response.headers.get('X-Request-Id'), 'request_01');
});

test('does not trust invalid or ambiguous query correlation on an early error', () => {
  for (const url of [
    '/api/v1/mcp/connection?requestId=not%20valid',
    '/api/v1/mcp/connection?requestId=request_01&requestId=request_02',
  ]) {
    const response = capture(new AppError('UNAUTHENTICATED'), { url });
    assert.match(response.headers.get('X-Request-Id') ?? '', /^[A-Za-z0-9_-]{22}$/);
    assert.notEqual(response.headers.get('X-Request-Id'), 'request_01');
    assert.notEqual(response.headers.get('X-Request-Id'), 'request_02');
  }
});

test('does not attempt a JSON error after an SSE response is committed or closed', () => {
  for (const responseState of [
    { headersSent: true },
    { writableEnded: true },
    { destroyed: true },
  ]) {
    const response = capture(
      new Error('stream closed'),
      { url: '/api/v1/boards/board_1/events' },
      responseState,
    );
    assert.equal(response.status, 0);
    assert.equal(response.body, undefined);
    assert.equal(response.headers.size, 0);
  }
});

test('keeps analytics errors in the closed non-enumerating envelope', () => {
  const unavailable = capture(new ShareAnalyticsError('SHARE_VIEW_UNAVAILABLE'), {
    url: '/api/v1/public/share-view-events',
  });
  assert.equal(unavailable.status, 404);
  assert.deepEqual(unavailable.body, {
    error: {
      code: 'SHARE_VIEW_UNAVAILABLE',
      message: 'Share view unavailable',
      requestId: unavailable.headers.get('X-Request-Id'),
    },
  });
  const unauthenticated = capture(
    new BoardContractError({
      protocolVersion: 1,
      type: 'board.error',
      code: 'UNAUTHENTICATED',
      message: 'Authentication is required',
      category: 'auth',
      retryable: false,
      httpStatusHint: 401,
      details: null,
    }),
    { url: '/api/v1/boards/board_1/share-analytics?from=2026-07-01&to=2026-07-31' },
  );
  assert.equal(unauthenticated.status, 401);
  assert.equal((unauthenticated.body as { error: { code: string } }).error.code, 'UNAUTHENTICATED');
});
