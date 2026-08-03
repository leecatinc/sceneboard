import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ArgumentsHost } from '@nestjs/common';

import { AppError, BoardContractError } from '../../src/common/errors/app-error.js';
import { invalidBoardPayload } from '../../src/common/errors/board-error.factory.js';
import { HttpErrorFilter } from '../../src/common/filters/http-error.filter.js';
import { ShareAnalyticsError } from '../../src/common/errors/share-analytics.error.js';
import { BOARD_REQUEST_ID } from '../../src/common/http/board-request-correlation.js';
import { CryptoService } from '../../src/common/security/crypto.service.js';
import { EXPORT_FAILURE_DEFINITIONS_V1, ExportFailureV1 } from '../../src/exports/export-errors.js';

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
  observeError: (bytes: string) => void = () => {},
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
  new HttpErrorFilter(crypto, { observe: observeError }).catch(error, host);
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

test('account API-key quota errors emit the complete private 429 tuple', () => {
  const response = capture(new AppError('RATE_LIMITED', { retryAfterSeconds: 2 }), {
    url: '/api/v1/account/api-keys',
  });
  assert.equal(response.status, 429);
  assert.deepEqual(response.body, {
    error: { code: 'RATE_LIMITED', message: 'Too many requests' },
  });
  assert.equal(response.headers.get('Retry-After'), '2');
  assert.equal(response.headers.get('Cache-Control'), 'no-store, private');
  assert.equal(response.headers.get('Pragma'), 'no-cache');
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

test('emits a fixed safe ERROR record without arbitrary exception data', () => {
  const canary = `sk-${'A'.repeat(43)}`;
  const records: string[] = [];
  const secretBearingKey = `credential-${canary}`;
  const response = capture(
    {
      email: 'user@example.invalid',
      diagnostic: { nested: canary },
      [secretBearingKey]: 'sensitive-value',
    },
    { url: '/api/v1/pairings/claim' },
    {},
    (bytes) => records.push(bytes),
  );
  assert.equal(response.status, 500);
  assert.equal(records.length, 1);
  assert.deepEqual(JSON.parse(records[0] ?? ''), {
    name: 'SafeOperationalError',
    message: 'Operation failed',
    details: {},
  });
  assert.equal(records[0]?.includes(canary), false);
  assert.equal(records[0]?.includes('user@example.invalid'), false);
  assert.equal(records[0]?.includes(secretBearingKey), false);
  assert.equal(records[0]?.includes('sensitive-value'), false);
});

test('does not traverse cyclic or accessor-bearing unknown errors', () => {
  const canary = `sk-${'A'.repeat(43)}`;
  const records: string[] = [];
  let accessorReads = 0;
  const exception: Record<string, unknown> = {
    diagnostic: canary,
    operation: 'database.read',
  };
  exception.self = exception;
  Object.defineProperty(exception, 'cause', {
    enumerable: true,
    get: () => {
      accessorReads += 1;
      throw new Error(`accessor exposed ${canary}`);
    },
  });

  const response = capture(
    exception,
    { url: '/api/v1/pairings/claim' },
    {},
    (bytes) => records.push(bytes),
  );

  assert.equal(response.status, 500);
  assert.deepEqual(response.body, {
    error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
  });
  assert.equal(records.length, 1);
  assert.deepEqual(JSON.parse(records[0] ?? '').details, {});
  assert.equal(accessorReads, 0);
  assert.equal(records[0]?.includes(canary), false);
  assert.equal(records[0]?.includes('database.read'), false);
});

test('keeps Error causes out of the HTTP response and ERROR observation', () => {
  const canary = `sk-${'A'.repeat(43)}`;
  const records: string[] = [];
  const response = capture(
    new Error('database unavailable', { cause: new Error(canary) }),
    { url: '/api/v1/pairings/claim' },
    {},
    (bytes) => records.push(bytes),
  );

  assert.equal(response.status, 500);
  assert.deepEqual(response.body, {
    error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
  });
  assert.equal(records.length, 1);
  assert.deepEqual(JSON.parse(records[0] ?? ''), {
    name: 'SafeOperationalError',
    message: 'Operation failed',
    details: {},
  });
  assert.equal(records[0]?.includes(canary), false);
  assert.equal(records[0]?.includes('database unavailable'), false);
});

test('aborts the HTTP response when the ERROR observer fails', () => {
  assert.throws(
    () =>
      capture(new Error('database unavailable'), { url: '/api/v1/pairings/claim' }, {}, () => {
        throw new Error('error sink unavailable');
      }),
    /error sink unavailable/u,
  );
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

test('projects every closed export failure tuple without inference or secret details', () => {
  for (const [code, definition] of Object.entries(EXPORT_FAILURE_DEFINITIONS_V1)) {
    const response = capture(new ExportFailureV1(code as never), {
      url: '/api/v1/boards/board_fixture/exports',
    });
    assert.equal(response.status, definition.httpStatus);
    assert.deepEqual(response.body, {
      ok: false,
      error: {
        code,
        message: definition.message,
        retryable: definition.retryable,
      },
    });
    assert.equal(JSON.stringify(response.body).includes('board_fixture'), false);
  }
});

test('maps pre-controller guard failures into the same closed export envelope', () => {
  const boardFailure = (
    code: 'UNAUTHENTICATED' | 'FORBIDDEN' | 'BOARD_NOT_FOUND',
    status: 401 | 403 | 404,
  ): BoardContractError =>
    new BoardContractError({
      protocolVersion: 1,
      type: 'board.error',
      code,
      message: 'fixture message',
      category: code === 'BOARD_NOT_FOUND' ? 'not_found' : 'auth',
      retryable: false,
      httpStatusHint: status,
      details: null,
    } as never);
  const cases: Array<[unknown, string, number]> = [
    [boardFailure('UNAUTHENTICATED', 401), 'EXPORT_UNAUTHENTICATED', 401],
    [boardFailure('FORBIDDEN', 403), 'EXPORT_FORBIDDEN', 403],
    [boardFailure('BOARD_NOT_FOUND', 404), 'EXPORT_NOT_FOUND', 404],
    [new AppError('INVALID_PAYLOAD'), 'EXPORT_INVALID_REQUEST', 400],
    [new AppError('RATE_LIMITED'), 'EXPORT_RATE_LIMITED', 429],
    [new AppError('SERVICE_UNAVAILABLE'), 'EXPORT_RENDERER_UNAVAILABLE', 503],
  ];
  for (const [failure, code, status] of cases) {
    const response = capture(failure, { url: '/api/v1/boards/board_fixture/exports' });
    assert.equal(response.status, status);
    assert.equal((response.body as { error: { code: string } }).error.code, code);
  }
});

test('preserves authoritative retry timing for board and closed export projections', () => {
  const rateLimited = new BoardContractError({
    protocolVersion: 1,
    type: 'board.error',
    code: 'RATE_LIMITED',
    message: 'Rate limited',
    category: 'rate_limit',
    retryable: true,
    httpStatusHint: 429,
    details: { retryAfterSeconds: 7 },
  });
  const unavailable = new BoardContractError({
    protocolVersion: 1,
    type: 'board.error',
    code: 'SERVICE_UNAVAILABLE',
    message: 'Service unavailable',
    category: 'availability',
    retryable: true,
    httpStatusHint: 503,
    details: { retryAfterSeconds: 13 },
  });

  for (const [failure, status, retryAfter] of [
    [rateLimited, 429, '7'],
    [unavailable, 503, '13'],
  ] as const) {
    const boardResponse = capture(failure, { url: '/api/v1/boards/board_fixture' });
    assert.equal(boardResponse.status, status);
    assert.equal(boardResponse.headers.get('Retry-After'), retryAfter);

    const exportResponse = capture(failure, {
      url: '/api/v1/boards/board_fixture/exports',
    });
    assert.equal(exportResponse.status, status);
    assert.equal(exportResponse.headers.get('Retry-After'), retryAfter);
  }

  const appFailure = capture(new AppError('RATE_LIMITED', { retryAfterSeconds: 17 }), {
    url: '/api/v1/boards/board_fixture/exports',
  });
  assert.equal(appFailure.headers.get('Retry-After'), '17');
});
