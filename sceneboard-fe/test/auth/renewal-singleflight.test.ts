import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BoardError, BoardErrorV1, BoardId } from '@sceneboard/board-schema';

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

const json = (body: unknown, status: number, generation?: string) =>
  new Response(JSON.stringify(body), {
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
    getItem(key) {
      return values.get(key) ?? null;
    },
    setItem(key, value) {
      values.set(key, value);
      writes.push(value);
    },
    removeItem(key) {
      values.delete(key);
    },
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
  const hintListeners = new Set<() => void>();
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
    subscribeGenerationHints(listener) {
      hintListeners.add(listener);
      return () => hintListeners.delete(listener);
    },
  });
  return {
    coordinator,
    values,
    writes,
    locks,
    requests,
    emitGenerationHint: () => {
      for (const listener of hintListeners) listener();
    },
    activeLockCount: () => activeLocks,
  };
};

test('Google login exchanges only the ID token through the existing exclusive session sequence', async () => {
  const anonymousGeneration = 'CCCCCCCCCCCCCCCCCCCCCC';
  const value = setup(
    [
      json(
        { error: { code: 'UNAUTHENTICATED', message: 'Authentication is required' } },
        401,
        'cleared',
      ),
      json(
        {
          csrfToken: 'lcbcsrf_v1.a.binding.nonce.1800000000000.mac',
          expiresAt: '2026-07-16T20:00:00.000Z',
        },
        200,
        anonymousGeneration,
      ),
      json(snapshot('session_google'), 200, generationA),
    ],
    'cleared',
  );
  const result = await value.coordinator.authenticate('google', { idToken: 'firebase-id-token' });
  assert.equal(value.requests.length, 3);
  assert.equal(result.kind, 'ok');
  assert.deepEqual(value.locks, ['exclusive']);
  assert.equal(value.requests[2]?.url, 'https://sceneboard.dev/api/v1/auth/google');
  assert.equal(value.requests[2]?.init?.body, JSON.stringify({ idToken: 'firebase-id-token' }));
  const headers = value.requests[2]?.init?.headers as Headers;
  assert.equal(headers.get('X-CSRF-Token'), 'lcbcsrf_v1.a.binding.nonce.1800000000000.mac');
});

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

test('binary upload binding freezes one generation and exact raw request identity', async () => {
  const uploaded = json({ ok: true }, 201);
  const value = setup([json(snapshot('session_1'), 200, generationA), uploaded]);
  await value.coordinator.reconcileSessionGeneration();
  const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' });
  const bound = await value.coordinator.bindBoardBinaryAttempt({
    requestId: 'request_media_1',
    path: '/api/v1/boards/board_1/media?requestId=request_media_1',
    contentType: 'image/png',
    contentDigest: 'sha-256=:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=:',
    idempotencyKey: 'media-upload-key-0001',
    csrfToken: csrf,
    blob,
  });
  assert.equal(bound.kind, 'bound');
  if (bound.kind !== 'bound') return;
  assert.equal(Object.isFrozen(bound.attempt), true);
  assert.equal(Object.isFrozen(bound.binding), true);
  assert.equal(bound.attempt.sessionGeneration, generationA);
  const result = await value.coordinator.dispatchBoardBinary(
    bound.attempt,
    new AbortController().signal,
  );
  assert.equal(result.kind, 'ok');
  assert.equal(value.requests.length, 2);
  assert.equal(
    value.requests[1]?.url,
    'https://sceneboard.dev/api/v1/boards/board_1/media?requestId=request_media_1',
  );
  const init = value.requests[1]?.init;
  assert.equal(init?.method, 'POST');
  assert.equal(init?.credentials, 'include');
  assert.equal(init?.body, blob);
  const headers = init?.headers as Headers;
  assert.equal(headers.get('Content-Type'), 'image/png');
  assert.equal(headers.get('Content-Digest'), bound.attempt.contentDigest);
  assert.equal(headers.get('Idempotency-Key'), 'media-upload-key-0001');
  assert.equal(headers.get('X-CSRF-Token'), csrf);
  assert.equal(headers.has('Origin'), false);
  assert.equal(headers.has('Content-Length'), false);
});

test('binary and generation-bound dispatches make zero fetches after generation drift', async () => {
  const value = setup([json(snapshot('session_1'), 200, generationA)]);
  await value.coordinator.reconcileSessionGeneration();
  const bound = await value.coordinator.bindBoardBinaryAttempt({
    requestId: 'request_media_1',
    path: '/api/v1/boards/board_1/media?requestId=request_media_1',
    contentType: 'image/png',
    contentDigest: 'sha-256=:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=:',
    idempotencyKey: 'media-upload-key-0001',
    csrfToken: csrf,
    blob: new Blob([new Uint8Array([1])], { type: 'image/png' }),
  });
  assert.equal(bound.kind, 'bound');
  if (bound.kind !== 'bound') return;
  let invalidated = 0;
  const unsubscribe = value.coordinator.subscribeGenerationInvalidation(
    bound.binding,
    () => invalidated++,
  );
  value.values.set(sessionCoordinationConstants.GENERATION_KEY, generationB);
  value.emitGenerationHint();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(invalidated, 1);
  assert.deepEqual(
    await value.coordinator.dispatchBoardBinary(bound.attempt, new AbortController().signal),
    { kind: 'stale_attempt' },
  );
  assert.deepEqual(
    await value.coordinator.dispatchSharedForGeneration(bound.binding, {
      path: '/api/v1/boards/board_1/mutations',
      method: 'POST',
      body: {},
      csrfToken: csrf,
    }),
    { kind: 'stale_attempt' },
  );
  assert.equal(value.requests.length, 1);
  unsubscribe();
});

test('two renewal callers share one exclusive acquisition and one renewal POST', async () => {
  const value = setup([
    json(snapshot('session_1'), 200, generationA),
    json(snapshot('session_1'), 200, generationA),
    json(snapshot('session_2'), 200, generationB),
  ]);
  await value.coordinator.reconcileSessionGeneration();
  const [first, second] = await Promise.all([
    value.coordinator.renewSession(),
    value.coordinator.renewSession(),
  ]);
  assert.equal(first.kind, 'ok');
  assert.equal(second.kind, 'ok');
  assert.deepEqual(value.locks, ['exclusive', 'exclusive']);
  assert.deepEqual(
    value.requests.map((request) => request.url),
    [
      'https://sceneboard.dev/api/v1/auth/session',
      'https://sceneboard.dev/api/v1/auth/session',
      'https://sceneboard.dev/api/v1/auth/session/renew',
    ],
  );
});

test('a shared 401 probes without rotating and invalidates an expired bound generation', async () => {
  const value = setup([
    json(snapshot('session_1'), 200, generationA),
    json({ error: { code: 'UNAUTHENTICATED', message: 'Authentication is required' } }, 401),
    json(
      { error: { code: 'UNAUTHENTICATED', message: 'Authentication is required' } },
      401,
      'cleared',
    ),
  ]);
  await value.coordinator.reconcileSessionGeneration();
  const bound = await value.coordinator.bindCurrentGeneration();
  assert.equal(bound.kind, 'bound');
  if (bound.kind !== 'bound') return;
  let invalidated = false;
  const unsubscribe = value.coordinator.subscribeGenerationInvalidation(bound.binding, () => {
    invalidated = true;
  });

  const result = await value.coordinator.dispatchShared({
    path: '/api/v1/boards',
    method: 'GET',
  });

  assert.equal(result.kind, 'reconciliation_required');
  assert.equal(invalidated, true);
  assert.equal(value.values.get(sessionCoordinationConstants.GENERATION_KEY), 'cleared');
  assert.deepEqual(
    value.requests.map((request) => request.url),
    [
      'https://sceneboard.dev/api/v1/auth/session',
      'https://sceneboard.dev/api/v1/boards',
      'https://sceneboard.dev/api/v1/auth/session',
    ],
  );
  unsubscribe();
});

test('an export 401 also reconciles and invalidates an expired bound generation', async () => {
  const value = setup([
    json(snapshot('session_1'), 200, generationA),
    json({ error: { code: 'UNAUTHENTICATED', message: 'Authentication is required' } }, 401),
    json(
      { error: { code: 'UNAUTHENTICATED', message: 'Authentication is required' } },
      401,
      'cleared',
    ),
  ]);
  await value.coordinator.reconcileSessionGeneration();
  const bound = await value.coordinator.bindCurrentGeneration();
  assert.equal(bound.kind, 'bound');
  if (bound.kind !== 'bound') return;
  let invalidated = false;
  const unsubscribe = value.coordinator.subscribeGenerationInvalidation(bound.binding, () => {
    invalidated = true;
  });

  const result = await value.coordinator.dispatchShared({
    path: '/api/v1/boards/board_1/exports',
    method: 'POST',
    body: { format: 'pdf', revisionId: 'revision_1' },
    csrfToken: csrf,
    responseKind: 'export',
  });

  assert.equal(result.kind, 'reconciliation_required');
  assert.equal(invalidated, true);
  assert.equal(value.values.get(sessionCoordinationConstants.GENERATION_KEY), 'cleared');
  assert.equal(value.requests[1]?.init?.redirect, 'manual');
  unsubscribe();
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

test('shared export dispatch uses manual redirects and cancels every redirect response before consumption', async () => {
  let cancellations = 0;
  const redirectBody = () =>
    new ReadableStream({
      cancel() {
        cancellations += 1;
      },
    });
  const sameOrigin = new Response(redirectBody(), {
    status: 302,
    headers: { Location: '/api/v1/boards/board_1/exports' },
  });
  const followed = new Response(redirectBody(), { status: 200 });
  Object.defineProperty(followed, 'redirected', { configurable: true, value: true });
  const opaque = new Response(redirectBody(), { status: 200 });
  Object.defineProperty(opaque, 'type', { configurable: true, value: 'opaqueredirect' });
  const value = setup([
    json(snapshot('session_1'), 200, generationA),
    sameOrigin,
    followed,
    opaque,
    json({ ok: true }, 200),
  ]);
  await value.coordinator.reconcileSessionGeneration();

  for (let index = 0; index < 3; index += 1) {
    const result = await value.coordinator.dispatchShared({
      path: '/api/v1/boards/board_1/exports',
      method: 'POST',
      body: { format: 'pdf', revisionId: 'revision_1' },
      csrfToken: csrf,
      responseKind: 'export',
    });
    assert.equal(result.kind, 'ok');
    if (result.kind === 'ok') {
      assert.equal(result.value.body, null);
      assert.equal(result.value.bytes.byteLength, 0);
    }
  }
  assert.equal(cancellations, 3);
  for (const request of value.requests.slice(1, 4)) assert.equal(request.init?.redirect, 'manual');

  await value.coordinator.dispatchShared({ path: '/api/v1/grants', method: 'GET' });
  assert.equal(value.requests[4]?.init?.redirect, undefined);
});

const boardError = (error: BoardError, status: number, retryAfter?: number): Response =>
  new Response(JSON.stringify({ error }), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store, private',
      ...(retryAfter === undefined ? {} : { 'Retry-After': String(retryAfter) }),
    },
  });

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

const upgradeRequired: BoardError = {
  protocolVersion: 1,
  type: 'board.error',
  code: 'UPGRADE_REQUIRED',
  message: 'A newer document client is required',
  category: 'conflict',
  retryable: false,
  httpStatusHint: 409,
  details: {
    headSchemaVersion: 3,
    requestedDocumentSchemaVersion: 1,
    surface: 'board.stream',
  },
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
  const result = await value.coordinator.open(
    {
      apiOrigin: 'https://sceneboard.dev',
      boardId,
      tabId: 'abcdefghijklmnopqrstuv',
      presenceState: 'online',
      cursor: 'opaque_cursor',
      signal,
    },
    async (response, heldSignal) => {
      assert.equal(value.activeLockCount(), 0);
      assert.equal(response, stream);
      assert.equal(heldSignal, signal);
      return 'consumed';
    },
  );
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
    kind: 'http_error',
    sourceStatus: 403,
    error: forbidden,
    retryAfterMs: null,
  });

  const second = setup([
    json(snapshot('session_1'), 200, generationA),
    boardError(unauthenticated, 401),
  ]);
  await second.coordinator.reconcileSessionGeneration();
  assert.deepEqual(await second.coordinator.open(input, async () => null), {
    kind: 'reconciliation_required',
    sourceStatus: 401,
    error: unauthenticated,
    acquisitionGeneration: generationA,
    retryAfterMs: null,
  });
});

test('stream dispatch admits only the exact 409 upgrade-required compatibility response', async () => {
  const input = {
    apiOrigin: 'https://sceneboard.dev',
    boardId,
    tabId: 'abcdefghijklmnopqrstuv',
    presenceState: 'online' as const,
    cursor: null,
    signal: new AbortController().signal,
  };
  const admitted = setup([
    json(snapshot('session_1'), 200, generationA),
    boardError(upgradeRequired, 409),
  ]);
  await admitted.coordinator.reconcileSessionGeneration();
  assert.deepEqual(await admitted.coordinator.open(input, async () => null), {
    kind: 'http_error',
    sourceStatus: 409,
    error: upgradeRequired,
    retryAfterMs: null,
  });

  const mismatched = setup([
    json(snapshot('session_1'), 200, generationA),
    boardError(upgradeRequired, 400),
  ]);
  await mismatched.coordinator.reconcileSessionGeneration();
  assert.deepEqual(await mismatched.coordinator.open(input, async () => null), {
    kind: 'protocol_error',
    sourceStatus: 400,
    error: upgradeRequired,
  });
});

test('stream dispatch rejects status/body mismatch, missing no-store, and caller-built origin drift', async () => {
  const value = setup([
    json(snapshot('session_1'), 200, generationA),
    new Response(JSON.stringify({ error: forbidden }), {
      status: 500,
      headers: { 'Cache-Control': 'no-store' },
    }),
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
    kind: 'protocol_error',
    sourceStatus: 500,
    error: forbidden,
  });
  await assert.rejects(
    () => value.coordinator.open({ ...input, apiOrigin: 'https://other.dev' }, async () => null),
    TypeError,
  );
  assert.equal(value.requests.length, 2);
});
