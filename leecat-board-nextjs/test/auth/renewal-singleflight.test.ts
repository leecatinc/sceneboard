import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BoardErrorV1, BoardId } from '@leecat-board/board-schema';

import {
  SessionRequestCoordinator,
  sessionCoordinationConstants,
  type GenerationStoragePort,
  type LockManagerPort,
} from '../../lib/auth/renewal-singleflight';

const generationA = 'AAAAAAAAAAAAAAAAAAAAAA';
const generationB = 'BBBBBBBBBBBBBBBBBBBBBB';
const boardId = 'board_1' as BoardId;
const csrf = 'lcbcsrf_v1.s.binding.nonce.1800000000000.mac';
const snapshot = (sessionId: string) => ({
  user: { userId: 'user_1', email: 'user@example.dev', createdAt: '2026-07-16T00:00:00.000Z' },
  session: {
    sessionId,
    idleExpiresAt: '2026-07-16T20:00:00.000Z',
    absoluteExpiresAt: '2026-07-23T12:00:00.000Z',
  },
  csrfToken: csrf,
});

const json = (body: unknown, status: number, generation?: string) => new Response(JSON.stringify(body), {
  status,
  headers: {
    'Content-Type': 'application/json',
    ...(generation === undefined ? {} : { 'X-Auth-Generation': generation }),
  },
});

const setup = (responses: Response[], initial: string | null = null) => {
  const values = new Map<string, string>();
  if (initial !== null) values.set(sessionCoordinationConstants.GENERATION_KEY, initial);
  const writes: string[] = [];
  const storage: GenerationStoragePort = {
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { values.set(key, value); writes.push(value); },
    removeItem(key) { values.delete(key); },
  };
  const locks: Array<'shared' | 'exclusive'> = [];
  let activeLocks = 0;
  const manager: LockManagerPort = {
    async request(_name, options, callback) {
      locks.push(options.mode);
      activeLocks += 1;
      try {
        return await callback();
      } finally {
        activeLocks -= 1;
      }
    },
  };
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const fetcher = async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(url), ...(init === undefined ? {} : { init }) });
    const response = responses.shift();
    if (response === undefined) throw new Error('unexpected fetch');
    return response;
  };
  const coordinator = new SessionRequestCoordinator('https://sceneboard.dev', {
    locks: manager,
    storage,
    fetcher,
    randomBytes: () => new Uint8Array(16).fill(7),
  });
  return { coordinator, values, writes, locks, requests, activeLockCount: () => activeLocks };
};

test('private reconciliation is one exclusive fixed session probe and commits generation after body consumption', async () => {
  const value = setup([json(snapshot('session_1'), 200, generationA)]);
  const result = await value.coordinator.reconcileSessionGeneration();
  assert.equal(result.kind, 'ok');
  assert.deepEqual(value.locks, ['exclusive']);
  assert.equal(value.requests.length, 1);
  assert.equal(value.requests[0]?.url, 'https://sceneboard.dev/api/v1/auth/session');
  assert.match(value.writes.at(-2) ?? '', /^unknown\./);
  assert.equal(value.writes.at(-1), generationA);
});

test('a stale application generation dispatches zero network traffic', async () => {
  const value = setup([json(snapshot('session_1'), 200, generationA)], generationA);
  await value.coordinator.reconcileSessionGeneration();
  value.values.set(sessionCoordinationConstants.GENERATION_KEY, generationB);
  const result = await value.coordinator.dispatchShared({ path: '/api/v1/grants', method: 'GET' });
  assert.equal(result.kind, 'reconciliation_required');
  assert.equal(value.requests.length, 1);
});

test('two renewal callers share one exclusive acquisition and one renewal POST', async () => {
  const value = setup([
    json(snapshot('session_1'), 200, generationA),
    json(snapshot('session_1'), 200, generationA),
    json(snapshot('session_2'), 200, generationB),
  ]);
  await value.coordinator.reconcileSessionGeneration();
  const [first, second] = await Promise.all([value.coordinator.renewSession(), value.coordinator.renewSession()]);
  assert.equal(first.kind, 'ok');
  assert.equal(second.kind, 'ok');
  assert.deepEqual(value.locks, ['exclusive', 'exclusive']);
  assert.deepEqual(value.requests.map((request) => request.url), [
    'https://sceneboard.dev/api/v1/auth/session',
    'https://sceneboard.dev/api/v1/auth/session',
    'https://sceneboard.dev/api/v1/auth/session/renew',
  ]);
});

test('logout commits an empty 204 response with the cleared generation proof', async () => {
  const value = setup([
    json(snapshot('session_1'), 200, generationA),
    new Response(null, { status: 204, headers: { 'X-Auth-Generation': 'cleared' } }),
  ]);
  await value.coordinator.reconcileSessionGeneration();

  assert.deepEqual(await value.coordinator.logout(), { kind: 'ok', value: null });
  assert.equal(value.values.get(sessionCoordinationConstants.GENERATION_KEY), 'cleared');
  assert.equal(value.requests[1]?.url, 'https://sceneboard.dev/api/v1/auth/logout');
});

test('response loss after intent publication leaves unknown and forbids a following request', async () => {
  const value = setup([json(snapshot('session_1'), 200, generationA)]);
  await value.coordinator.reconcileSessionGeneration();
  const result = await value.coordinator.renewSession();
  assert.equal(result.kind, 'reconciliation_required');
  assert.match(value.values.get(sessionCoordinationConstants.GENERATION_KEY) ?? '', /^unknown\./);
  assert.equal(value.requests.length, 2);
});

const boardError = (error: BoardErrorV1, status: number, retryAfter?: number): Response => new Response(
  JSON.stringify({ error }),
  {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store, private',
      ...(retryAfter === undefined ? {} : { 'Retry-After': String(retryAfter) }),
    },
  },
);

const forbidden: BoardErrorV1 = {
  protocolVersion: 1,
  type: 'board.error',
  code: 'FORBIDDEN',
  message: 'Forbidden',
  category: 'auth',
  retryable: false,
  httpStatusHint: 403,
  details: null,
};

test('closed board stream request releases its shared coordinator lease before consuming the long-lived response', async () => {
  const stream = new Response('event bytes', {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-store, private',
    },
  });
  const value = setup([json(snapshot('session_1'), 200, generationA), stream]);
  await value.coordinator.reconcileSessionGeneration();
  const signal = new AbortController().signal;
  const result = await value.coordinator.open({
    apiOrigin: 'https://sceneboard.dev',
    boardId,
    tabId: 'abcdefghijklmnopqrstuv',
    presenceState: 'online',
    cursor: 'opaque_cursor',
    signal,
  }, async (response, heldSignal) => {
    assert.equal(value.activeLockCount(), 0);
    assert.equal(response, stream);
    assert.equal(heldSignal, signal);
    return 'consumed';
  });
  assert.deepEqual(result, { kind: 'consumed', value: 'consumed' });
  assert.deepEqual(value.locks, ['exclusive', 'shared']);
  assert.equal(
    value.requests[1]?.url,
    'https://sceneboard.dev/api/v1/boards/board_1/events?tabId=abcdefghijklmnopqrstuv&presenceState=online',
  );
  const init = value.requests[1]?.init;
  assert.equal(init?.method, 'GET');
  assert.equal(init?.credentials, 'include');
  assert.equal(init?.signal, signal);
  const headers = init?.headers as Headers;
  assert.equal(headers.get('Accept'), 'text/event-stream');
  assert.equal(headers.get('Last-Event-ID'), 'opaque_cursor');
});

test('stream dispatch keeps 403 distinct and maps 401 to acquisition-generation reconciliation', async () => {
  const unauthenticated: BoardErrorV1 = {
    protocolVersion: 1,
    type: 'board.error',
    code: 'UNAUTHENTICATED',
    message: 'Authentication is required',
    category: 'auth',
    retryable: false,
    httpStatusHint: 401,
    details: null,
  };
  const first = setup([json(snapshot('session_1'), 200, generationA), boardError(forbidden, 403)]);
  await first.coordinator.reconcileSessionGeneration();
  const input = {
    apiOrigin: 'https://sceneboard.dev',
    boardId,
    tabId: 'abcdefghijklmnopqrstuv',
    presenceState: 'away' as const,
    cursor: null,
    signal: new AbortController().signal,
  };
  assert.deepEqual(await first.coordinator.open(input, async () => null), {
    kind: 'http_error', sourceStatus: 403, error: forbidden, retryAfterMs: null,
  });

  const second = setup([json(snapshot('session_1'), 200, generationA), boardError(unauthenticated, 401)]);
  await second.coordinator.reconcileSessionGeneration();
  assert.deepEqual(await second.coordinator.open(input, async () => null), {
    kind: 'reconciliation_required',
    sourceStatus: 401,
    error: unauthenticated,
    acquisitionGeneration: generationA,
    retryAfterMs: null,
  });
});

test('stream dispatch rejects status/body mismatch, missing no-store, and caller-built origin drift', async () => {
  const value = setup([
    json(snapshot('session_1'), 200, generationA),
    new Response(JSON.stringify({ error: forbidden }), { status: 500, headers: { 'Cache-Control': 'no-store' } }),
  ]);
  await value.coordinator.reconcileSessionGeneration();
  const input = {
    apiOrigin: 'https://sceneboard.dev',
    boardId,
    tabId: 'abcdefghijklmnopqrstuv',
    presenceState: 'online' as const,
    cursor: null,
    signal: new AbortController().signal,
  };
  assert.deepEqual(await value.coordinator.open(input, async () => null), {
    kind: 'protocol_error', sourceStatus: 500, error: forbidden,
  });
  await assert.rejects(() => value.coordinator.open({ ...input, apiOrigin: 'https://other.dev' }, async () => null), TypeError);
  assert.equal(value.requests.length, 2);
});
