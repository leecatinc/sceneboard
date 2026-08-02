import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AccountApiKeyApi,
  AccountApiKeyRequestOwnership,
  AccountApiKeyStaleRecovery,
} from '../../lib/api/account-api-key-api';
import {
  SessionRequestCoordinator,
  browserSessionCoordinator,
  sessionCoordinationConstants,
  type GenerationStoragePort,
  type LockManagerPort,
} from '../../lib/auth/renewal-singleflight';
import type {
  ConsumedResponse,
  CurrentGenerationBindingV1,
  SharedCookieRequest,
} from '../../lib/auth/renewal-singleflight';

const csrfToken = 'lcbcsrf_v1.s.binding.nonce.1800000000000.mac';
const rawKey = 'sbk_v1.AAAAAAAAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const metadata = {
  apiKeyId: 'key_public_1',
  name: 'Automation',
  prefix: 'sbk_v1.AAAAAAAA…',
  scopes: ['board:read'],
  status: 'active',
  createdAt: '2026-07-30T00:00:00.000Z',
  expiresAt: '2026-10-28T00:00:00.000Z',
  lastUsedAt: null,
};
const generationBinding = Object.freeze({
  sessionGeneration: 'AAAAAAAAAAAAAAAAAAAAAA',
}) as CurrentGenerationBindingV1;

const deferred = <Value>() => {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
};

const consumed = (status: number, body: unknown): ConsumedResponse => ({
  response: new Response(status === 204 ? null : JSON.stringify(body), { status }),
  body,
  bytes: status === 204 ? new Uint8Array() : new TextEncoder().encode(JSON.stringify(body)),
});

const setup = (responses: ConsumedResponse[]) => {
  const requests: SharedCookieRequest[] = [];
  const coordinator = {
    currentSnapshot: () => ({ csrfToken }),
    bindCurrentGeneration: async () => ({ kind: 'bound' as const, binding: generationBinding }),
    dispatchShared: async (request: SharedCookieRequest) => {
      requests.push(request);
      const response = responses.shift();
      if (response === undefined) throw new TypeError('missing fixture response');
      return { kind: 'ok' as const, value: response };
    },
    dispatchSharedForGeneration: async (
      binding: CurrentGenerationBindingV1,
      request: SharedCookieRequest,
    ) => {
      assert.equal(binding, generationBinding);
      requests.push(request);
      const response = responses.shift();
      if (response === undefined) throw new TypeError('missing fixture response');
      return { kind: 'ok' as const, value: response };
    },
  } as unknown as SessionRequestCoordinator;
  return { api: new AccountApiKeyApi(coordinator), requests };
};

test('account API-key adapter sends closed session requests and never persists the raw key', async () => {
  const value = setup([
    consumed(200, { items: [metadata], nextCursor: null }),
    consumed(201, { apiKey: rawKey, metadata }),
    consumed(204, null),
  ]);
  const signal = new AbortController().signal;
  const listed = await value.api.list(generationBinding, null, signal);
  const created = await value.api.create(
    {
      displayName: 'Automation',
      scopes: ['board:read'],
      expiresInDays: 90,
    },
    signal,
  );
  const revoked = await value.api.revoke(generationBinding, metadata.apiKeyId, signal);
  assert.equal(listed.kind, 'ok');
  assert.deepEqual(listed, { kind: 'ok', value: { items: [metadata], nextCursor: null } });
  assert.deepEqual(created, {
    kind: 'ok',
    value: { apiKey: rawKey, metadata, generationBinding },
  });
  assert.deepEqual(revoked, { kind: 'ok', value: null });
  assert.deepEqual(
    value.requests.map(({ path, method, csrfToken: csrf, body }) => ({
      path,
      method,
      csrf,
      body,
    })),
    [
      {
        path: '/api/v1/account/api-keys?limit=20',
        method: 'GET',
        csrf: csrfToken,
        body: undefined,
      },
      {
        path: '/api/v1/account/api-keys',
        method: 'POST',
        csrf: csrfToken,
        body: {
          displayName: 'Automation',
          scopes: ['board:read'],
          expiresInDays: 90,
        },
      },
      {
        path: '/api/v1/account/api-keys/key_public_1',
        method: 'DELETE',
        csrf: csrfToken,
        body: undefined,
      },
    ],
  );
  assert.equal(
    value.requests.every((request) => request.signal === signal),
    true,
  );
  assert.equal(JSON.stringify(value.requests).includes(rawKey), false);
});

test('account API-key adapter rejects response shape drift and requires an active session', async () => {
  const corrupt = setup([
    consumed(200, { items: [{ ...metadata, rawKey }], nextCursor: null }),
    consumed(201, { apiKey: `${rawKey}x`, metadata }),
  ]);
  assert.deepEqual(await corrupt.api.list(generationBinding), { kind: 'corrupt_response' });
  assert.deepEqual(
    await corrupt.api.create({
      displayName: 'Automation',
      scopes: ['board:read'],
      expiresInDays: 90,
    }),
    { kind: 'corrupt_response' },
  );
  const sessionless = new AccountApiKeyApi({
    currentSnapshot: () => null,
  } as unknown as SessionRequestCoordinator);
  assert.deepEqual(await sessionless.list(generationBinding), { kind: 'stale_attempt' });
});

test('account API-key adapter accepts reordered exact response members and rejects missing members', async () => {
  const reorderedMetadata = {
    lastUsedAt: null,
    expiresAt: metadata.expiresAt,
    createdAt: metadata.createdAt,
    status: metadata.status,
    scopes: metadata.scopes,
    prefix: metadata.prefix,
    name: metadata.name,
    apiKeyId: metadata.apiKeyId,
  };
  const value = setup([
    consumed(200, { nextCursor: null, items: [reorderedMetadata] }),
    consumed(201, { metadata: reorderedMetadata, apiKey: rawKey }),
    consumed(200, { nextCursor: null }),
  ]);

  assert.deepEqual(await value.api.list(generationBinding), {
    kind: 'ok',
    value: { items: [metadata], nextCursor: null },
  });
  assert.deepEqual(
    await value.api.create({
      displayName: 'Automation',
      scopes: ['board:read'],
      expiresInDays: 90,
    }),
    {
      kind: 'ok',
      value: { apiKey: rawKey, metadata, generationBinding },
    },
  );
  assert.deepEqual(await value.api.list(generationBinding), { kind: 'corrupt_response' });
});

test('account API-key adapter rejects every invalid metadata value class', async () => {
  const invalidMetadata: Array<{ name: string; value: Record<string, unknown> }> = [
    { name: 'empty API-key ID', value: { ...metadata, apiKeyId: '' } },
    { name: 'invalid API-key ID alphabet', value: { ...metadata, apiKeyId: 'key.public' } },
    { name: 'oversized API-key ID', value: { ...metadata, apiKeyId: 'a'.repeat(129) } },
    { name: 'empty name', value: { ...metadata, name: '' } },
    { name: 'untrimmed name', value: { ...metadata, name: ' Automation' } },
    { name: 'oversized Unicode name', value: { ...metadata, name: '🙂'.repeat(81) } },
    { name: 'invalid prefix', value: { ...metadata, prefix: 'sbk_v1.AAAAAAA…' } },
    { name: 'empty scopes', value: { ...metadata, scopes: [] } },
    { name: 'unknown scope', value: { ...metadata, scopes: ['account:admin'] } },
    {
      name: 'duplicate scopes',
      value: { ...metadata, scopes: ['board:read', 'board:read'] },
    },
    {
      name: 'unsorted scopes',
      value: { ...metadata, scopes: ['board:write', 'board:read'] },
    },
    { name: 'invalid status', value: { ...metadata, status: 'disabled' } },
    { name: 'non-canonical created timestamp', value: { ...metadata, createdAt: '2026-07-30' } },
    {
      name: 'non-canonical expiry timestamp',
      value: { ...metadata, expiresAt: '2026-10-28T00:00:00Z' },
    },
    { name: 'expiry before creation', value: { ...metadata, expiresAt: metadata.createdAt } },
    { name: 'non-canonical last-used timestamp', value: { ...metadata, lastUsedAt: 'yesterday' } },
    {
      name: 'last-used before creation',
      value: { ...metadata, lastUsedAt: '2026-07-29T23:59:59.999Z' },
    },
  ];

  for (const fixture of invalidMetadata) {
    const value = setup([consumed(200, { items: [fixture.value], nextCursor: null })]);
    assert.deepEqual(
      await value.api.list(generationBinding),
      { kind: 'corrupt_response' },
      fixture.name,
    );
  }
});

test('account API-key adapter accepts last use at or after expiry and keeps the key revocable', async () => {
  const atExpiry = { ...metadata, lastUsedAt: metadata.expiresAt };
  const afterExpiry = {
    ...metadata,
    apiKeyId: 'key_public_2',
    lastUsedAt: '2026-10-28T00:00:00.001Z',
  };
  const value = setup([
    consumed(200, { items: [atExpiry, afterExpiry], nextCursor: null }),
    consumed(204, null),
  ]);

  assert.deepEqual(await value.api.list(generationBinding), {
    kind: 'ok',
    value: { items: [atExpiry, afterExpiry], nextCursor: null },
  });
  assert.deepEqual(await value.api.revoke(generationBinding, afterExpiry.apiKeyId), {
    kind: 'ok',
    value: null,
  });
});

test('account API-key adapter rejects invalid page bounds, cursors, and successful status tuples', async () => {
  const oversizedPage = Array.from({ length: 21 }, (_, index) => ({
    ...metadata,
    apiKeyId: `key_public_${index + 1}`,
  }));
  const duplicatePage = [metadata, { ...metadata }];
  const corruptLists = [
    { name: 'oversized page', body: { items: oversizedPage, nextCursor: null } },
    { name: 'duplicate page ID', body: { items: duplicatePage, nextCursor: null } },
    { name: 'empty cursor', body: { items: [metadata], nextCursor: '' } },
    { name: 'oversized cursor', body: { items: [metadata], nextCursor: 'a'.repeat(513) } },
    { name: 'non-canonical cursor', body: { items: [metadata], nextCursor: 'cursor/page' } },
  ];
  for (const fixture of corruptLists) {
    const value = setup([consumed(200, fixture.body)]);
    assert.deepEqual(
      await value.api.list(generationBinding),
      { kind: 'corrupt_response' },
      fixture.name,
    );
  }

  const wrongGet = setup([consumed(201, { items: [metadata], nextCursor: null })]);
  assert.deepEqual(await wrongGet.api.list(generationBinding), { kind: 'corrupt_response' });

  const wrongPost = setup([consumed(200, { apiKey: rawKey, metadata })]);
  const created = await wrongPost.api.create({
    displayName: 'Automation',
    scopes: ['board:read'],
    expiresInDays: 90,
  });
  assert.deepEqual(created, { kind: 'corrupt_response' });
  assert.equal(JSON.stringify(created).includes(rawKey), false);

  const wrongDelete = setup([consumed(200, null)]);
  assert.deepEqual(await wrongDelete.api.revoke(generationBinding, metadata.apiKeyId), {
    kind: 'corrupt_response',
  });

  const nonEmptyDelete = setup([
    {
      response: new Response(null, { status: 204 }),
      body: { unexpected: true },
      bytes: new TextEncoder().encode('{}'),
    },
  ]);
  assert.deepEqual(await nonEmptyDelete.api.revoke(generationBinding, metadata.apiKeyId), {
    kind: 'corrupt_response',
  });
});

test('account API-key adapter preserves and encodes cursors across first, middle, and final pages', async () => {
  const cursor1 = 'cursor_page_1_owner';
  const cursor2 = 'cursor_page_2';
  const firstPage = Array.from({ length: 20 }, (_, index) => ({
    ...metadata,
    apiKeyId: `key_public_${index + 1}`,
    status: 'revoked',
  }));
  const middlePage = [
    { ...metadata, apiKeyId: 'key_public_20', status: 'revoked' },
    { ...metadata, apiKeyId: 'key_public_21', status: 'active' },
  ];
  const value = setup([
    consumed(200, { items: firstPage, nextCursor: cursor1 }),
    consumed(200, { items: middlePage, nextCursor: cursor2 }),
    consumed(200, { items: [], nextCursor: null }),
  ]);

  assert.deepEqual(await value.api.list(generationBinding), {
    kind: 'ok',
    value: { items: firstPage, nextCursor: cursor1 },
  });
  assert.deepEqual(await value.api.list(generationBinding, cursor1), {
    kind: 'ok',
    value: { items: middlePage, nextCursor: cursor2 },
  });
  assert.deepEqual(await value.api.list(generationBinding, cursor2), {
    kind: 'ok',
    value: { items: [], nextCursor: null },
  });
  assert.deepEqual(
    value.requests.map((request) => request.path),
    [
      '/api/v1/account/api-keys?limit=20',
      `/api/v1/account/api-keys?limit=20&cursor=${encodeURIComponent(cursor1)}`,
      `/api/v1/account/api-keys?limit=20&cursor=${encodeURIComponent(cursor2)}`,
    ],
  );
  assert.equal(middlePage[1]?.status, 'active');
});

test('account API-key list can recover from an expired cursor and resume continuation', async () => {
  const expiredCursor = 'expired-cursor';
  const freshCursor = 'fresh-cursor';
  const value = setup([
    consumed(400, { error: { code: 'INVALID_PAYLOAD' } }),
    consumed(200, { items: [metadata], nextCursor: freshCursor }),
    consumed(200, {
      items: [{ ...metadata, apiKeyId: 'key_public_2' }],
      nextCursor: null,
    }),
  ]);

  assert.deepEqual(await value.api.list(generationBinding, expiredCursor), {
    kind: 'api_error',
    status: 400,
  });
  assert.equal((await value.api.list(generationBinding, null)).kind, 'ok');
  assert.equal((await value.api.list(generationBinding, freshCursor)).kind, 'ok');
  assert.deepEqual(
    value.requests.map((request) => request.path),
    [
      `/api/v1/account/api-keys?limit=20&cursor=${encodeURIComponent(expiredCursor)}`,
      '/api/v1/account/api-keys?limit=20',
      `/api/v1/account/api-keys?limit=20&cursor=${encodeURIComponent(freshCursor)}`,
    ],
  );
});

test('generation-valid 503 responses remain API errors for every management operation and direct callers', async () => {
  const generation = 'AAAAAAAAAAAAAAAAAAAAAA';
  const values = new Map<string, string>();
  const requestPaths: string[] = [];
  const storage: GenerationStoragePort = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
  const locks: LockManagerPort = {
    request: async (_name, _options, callback) => await callback(),
  };
  const snapshot = {
    user: {
      userId: 'user_1',
      email: 'user@example.dev',
      createdAt: '2026-07-30T00:00:00.000Z',
    },
    session: {
      sessionId: 'session_1',
      idleExpiresAt: '2026-07-30T01:00:00.000Z',
      absoluteExpiresAt: '2026-08-06T00:00:00.000Z',
    },
    csrfToken,
  };
  const coordinator = new SessionRequestCoordinator('https://sceneboard.dev', {
    locks,
    storage,
    fetcher: async (input) => {
      const path = new URL(String(input)).pathname;
      requestPaths.push(path);
      if (path === '/api/v1/auth/session') {
        return new Response(JSON.stringify(snapshot), {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            'X-Auth-Generation': generation,
          },
        });
      }
      if (path === '/api/v1/boards/board_1/unauthorized') {
        return new Response(JSON.stringify({ error: { code: 'UNAUTHENTICATED' } }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ error: { code: 'SERVICE_UNAVAILABLE' } }), {
        status: 503,
        headers: { 'Content-Type': 'application/json' },
      });
    },
    randomBytes: () => new Uint8Array(16).fill(3),
  });
  assert.equal((await coordinator.reconcileSessionGeneration()).kind, 'ok');
  const admitted = await coordinator.bindCurrentGeneration();
  assert.equal(admitted.kind, 'bound');
  if (admitted.kind !== 'bound') return;
  const api = new AccountApiKeyApi(coordinator);
  const unavailable = { kind: 'api_error' as const, status: 503 };

  assert.deepEqual(await api.list(admitted.binding), unavailable, 'initial list');
  assert.deepEqual(await api.list(admitted.binding, 'next_cursor'), unavailable, 'continuation');
  assert.deepEqual(
    await api.create({
      displayName: 'Automation',
      scopes: ['board:read'],
      expiresInDays: 90,
    }),
    unavailable,
    'create',
  );
  assert.deepEqual(await api.revoke(admitted.binding, metadata.apiKeyId), unavailable, 'revoke');
  const direct = await coordinator.dispatchSharedForGeneration(admitted.binding, {
    path: '/api/v1/boards/board_1/mutations',
    method: 'POST',
    body: {},
    csrfToken,
  });
  assert.equal(direct.kind, 'ok');
  if (direct.kind === 'ok') assert.equal(direct.value.response.status, 503);
  assert.deepEqual(
    await coordinator.dispatchSharedForGeneration(admitted.binding, {
      path: '/api/v1/boards/board_1/unauthorized',
      method: 'POST',
      body: {},
      csrfToken,
    }),
    { kind: 'stale_attempt' },
    '401 must retain stale-session recovery semantics',
  );
  assert.equal(
    requestPaths.filter((path) => path === '/api/v1/auth/session').length,
    1,
    'feature 503s must not trigger session reconciliation',
  );
});

test('stale list and mutation outcomes synchronously scrub and share one recovery transition', async () => {
  for (const operation of ['initial list', 'continuation list', 'create', 'revoke'] as const) {
    const recovery = new AccountApiKeyStaleRecovery();
    const reconciled = deferred<
      | { kind: 'ok'; value: { session: { sessionId: string } } | null }
      | { kind: 'reconciliation_required' }
    >();
    const state = {
      items: [metadata],
      secret: rawKey as string | null,
      busy: operation === 'create' || operation === 'revoke',
      continuation: operation === 'continuation list' ? 'loading' : 'idle',
      redirected: null as '/login' | '/settings/ai-connections' | null,
      failed: false,
    };
    let reconcileCalls = 0;
    const transition = recovery.recover({
      scrub: () => {
        state.items = [];
        state.secret = null;
        state.busy = false;
        state.continuation = 'idle';
      },
      reconcile: () => {
        reconcileCalls += 1;
        assert.deepEqual(state.items, [], operation);
        assert.equal(state.secret, null, operation);
        assert.equal(state.busy, false, operation);
        assert.equal(state.continuation, 'idle', operation);
        return reconciled.promise;
      },
      onSignedOut: () => {
        state.redirected = '/login';
      },
      onActive: () => {
        state.redirected = '/settings/ai-connections';
      },
      onFailed: () => {
        state.failed = true;
      },
    });
    assert.equal(reconcileCalls, 1, operation);
    assert.deepEqual(state.items, [], operation);
    assert.equal(state.secret, null, operation);

    reconciled.resolve(
      operation === 'initial list'
        ? { kind: 'ok', value: null }
        : operation === 'continuation list'
          ? { kind: 'reconciliation_required' }
          : { kind: 'ok', value: { session: { sessionId: 'fresh_session' } } },
    );
    await transition;
    assert.equal(
      state.redirected,
      operation === 'initial list'
        ? '/login'
        : operation === 'create' || operation === 'revoke'
          ? '/settings/ai-connections'
          : null,
      operation,
    );
    assert.equal(state.failed, operation === 'continuation list', operation);
  }
});

test('concurrent stale outcomes perform exactly one session reconciliation', async () => {
  const recovery = new AccountApiKeyStaleRecovery();
  const reconciled = deferred<{ kind: 'ok'; value: null }>();
  let scrubs = 0;
  let reconciliations = 0;
  let redirects = 0;
  const callbacks = {
    scrub: () => scrubs++,
    reconcile: () => {
      reconciliations += 1;
      return reconciled.promise;
    },
    onSignedOut: () => redirects++,
    onActive: () => assert.fail('unexpected active session'),
    onFailed: () => assert.fail('unexpected reconciliation failure'),
  };
  const first = recovery.recover(callbacks);
  const second = recovery.recover(callbacks);
  assert.equal(scrubs, 2);
  assert.equal(reconciliations, 1);
  reconciled.resolve({ kind: 'ok', value: null });
  await Promise.all([first, second]);
  assert.equal(redirects, 1);
});

test('browser session coordinator returns unsupported without fetching for missing capabilities', async () => {
  const descriptors = new Map<PropertyKey, PropertyDescriptor | undefined>();
  const replaceGlobal = (key: PropertyKey, descriptor: PropertyDescriptor) => {
    if (!descriptors.has(key))
      descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, ...descriptor });
  };
  const restoreGlobals = () => {
    for (const [key, descriptor] of descriptors) {
      if (descriptor === undefined) Reflect.deleteProperty(globalThis, key);
      else Object.defineProperty(globalThis, key, descriptor);
    }
  };
  const storage = () => {
    const values = new Map<string, string>();
    return {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    };
  };
  const locks = {
    request: async <Value>(
      _name: string,
      _options: { mode: 'shared' | 'exclusive' },
      callback: () => Promise<Value>,
    ) => await callback(),
  };

  try {
    let fetches = 0;
    replaceGlobal('fetch', { value: async () => (fetches += 1) as never, writable: true });
    replaceGlobal('navigator', { value: {}, writable: true });
    replaceGlobal('localStorage', { value: storage(), writable: true });
    replaceGlobal('BroadcastChannel', {
      value: class UnexpectedChannel {
        constructor() {
          assert.fail('channel must not be constructed without Web Locks');
        }
      },
      writable: true,
    });
    const missingLocks = browserSessionCoordinator('https://sceneboard.dev');
    assert.deepEqual(await missingLocks.reconcileSessionGeneration(), {
      kind: 'unsupported_browser',
    });
    assert.equal(fetches, 0);

    replaceGlobal('navigator', { value: { locks }, writable: true });
    replaceGlobal('localStorage', {
      get() {
        throw new DOMException('blocked', 'SecurityError');
      },
    });
    const blockedStorage = browserSessionCoordinator('https://sceneboard.dev');
    assert.deepEqual(await blockedStorage.reconcileSessionGeneration(), {
      kind: 'unsupported_browser',
    });
    assert.equal(fetches, 0);

    replaceGlobal('localStorage', { value: storage(), writable: true });
    replaceGlobal('BroadcastChannel', { value: undefined, writable: true });
    const missingChannel = browserSessionCoordinator('https://sceneboard.dev');
    assert.deepEqual(await missingChannel.reconcileSessionGeneration(), {
      kind: 'unsupported_browser',
    });
    assert.equal(fetches, 0);

    replaceGlobal('BroadcastChannel', {
      value: class ThrowingChannel {
        constructor() {
          throw new DOMException('blocked', 'SecurityError');
        }
      },
      writable: true,
    });
    const throwingChannel = browserSessionCoordinator('https://sceneboard.dev');
    assert.deepEqual(await throwingChannel.reconcileSessionGeneration(), {
      kind: 'unsupported_browser',
    });
    assert.equal(fetches, 0);
  } finally {
    restoreGlobals();
  }
});

test('continuation ownership remains independent across overlapping create and revoke mutations', async () => {
  for (const mutationName of ['create', 'revoke'] as const) {
    const ownership = new AccountApiKeyRequestOwnership();
    const continuation = deferred<void>();
    const mutation = deferred<void>();
    let continuationState: 'loading' | 'idle' = 'loading';
    let busy = true;
    const listController = ownership.begin('list', () => {
      continuationState = 'idle';
    });
    const mutationController = ownership.begin('mutation', () => {
      busy = false;
    });
    const continuationCompletion = continuation.promise.then(() => {
      if (ownership.finish('list', listController)) continuationState = 'idle';
    });
    const mutationCompletion = mutation.promise.then(() => {
      if (ownership.finish('mutation', mutationController)) busy = false;
    });

    mutation.resolve();
    await mutationCompletion;
    assert.equal(listController.signal.aborted, false, mutationName);
    assert.equal(continuationState, 'loading', mutationName);
    assert.equal(busy, false, mutationName);
    continuation.resolve();
    await continuationCompletion;
    assert.equal(continuationState, 'idle', mutationName);
  }
});

test('request ownership settles continuation and mutation flags on invalidation or unmount', () => {
  for (const reason of ['invalidation', 'unmount'] as const) {
    const ownership = new AccountApiKeyRequestOwnership();
    let continuationState: 'loading' | 'idle' = 'loading';
    let busy = true;
    const listController = ownership.begin('list', () => {
      continuationState = 'idle';
    });
    const mutationController = ownership.begin('mutation', () => {
      busy = false;
    });

    ownership.abortAll();

    assert.equal(listController.signal.aborted, true, reason);
    assert.equal(mutationController.signal.aborted, true, reason);
    assert.equal(continuationState, 'idle', reason);
    assert.equal(busy, false, reason);
  }
});

test('account API-key creation discards a response after its generation becomes stale', async () => {
  const requests: SharedCookieRequest[] = [];
  const coordinator = {
    currentSnapshot: () => ({ csrfToken }),
    bindCurrentGeneration: async () => ({ kind: 'bound' as const, binding: generationBinding }),
    dispatchSharedForGeneration: async (
      _binding: CurrentGenerationBindingV1,
      request: SharedCookieRequest,
    ) => {
      requests.push(request);
      return { kind: 'stale_attempt' as const };
    },
  } as unknown as SessionRequestCoordinator;
  const api = new AccountApiKeyApi(coordinator);

  assert.deepEqual(
    await api.create({
      displayName: 'Automation',
      scopes: ['board:read'],
      expiresInDays: 90,
    }),
    { kind: 'stale_attempt' },
  );
  assert.equal(requests.length, 1);
  assert.equal(JSON.stringify(requests).includes(rawKey), false);
});

test('a second tab generation change invalidates a displayed secret and rejects stale creation', async () => {
  const generationA = 'AAAAAAAAAAAAAAAAAAAAAA';
  const generationB = 'BBBBBBBBBBBBBBBBBBBBBB';
  const values = new Map<string, string>();
  const listeners = new Set<() => void>();
  const storage: GenerationStoragePort = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
  const locks: LockManagerPort = {
    request: async (_name, _options, callback) => await callback(),
  };
  const snapshot = {
    user: {
      userId: 'user_1',
      email: 'user@example.dev',
      createdAt: '2026-07-30T00:00:00.000Z',
    },
    session: {
      sessionId: 'session_1',
      idleExpiresAt: '2026-07-30T01:00:00.000Z',
      absoluteExpiresAt: '2026-08-06T00:00:00.000Z',
    },
    csrfToken,
  };
  const coordinator = (generation: string) =>
    new SessionRequestCoordinator('https://sceneboard.dev', {
      locks,
      storage,
      fetcher: async () =>
        new Response(JSON.stringify(snapshot), {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            'X-Auth-Generation': generation,
          },
        }),
      randomBytes: () => new Uint8Array(16).fill(3),
      notify: () => {
        for (const listener of listeners) listener();
      },
      subscribeGenerationHints(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    });
  const firstTab = coordinator(generationA);
  assert.equal((await firstTab.reconcileSessionGeneration()).kind, 'ok');
  const bound = await firstTab.bindCurrentGeneration();
  assert.equal(bound.kind, 'bound');
  if (bound.kind !== 'bound') return;
  let displayedSecret: string | null = rawKey;
  const unsubscribe = firstTab.subscribeGenerationInvalidation(bound.binding, () => {
    displayedSecret = null;
  });

  const secondTab = coordinator(generationB);
  assert.equal((await secondTab.reconcileSessionGeneration()).kind, 'ok');
  assert.equal(values.get(sessionCoordinationConstants.GENERATION_KEY), generationB);
  assert.equal(displayedSecret, null);
  assert.deepEqual(
    await new AccountApiKeyApi(firstTab).create({
      displayName: 'Automation',
      scopes: ['board:read'],
      expiresInDays: 90,
    }),
    { kind: 'stale_attempt' },
  );
  unsubscribe();
});

test('a second tab account change scrubs rendered metadata and rejects a deferred list publication', async () => {
  const generationA = 'AAAAAAAAAAAAAAAAAAAAAA';
  const generationB = 'BBBBBBBBBBBBBBBBBBBBBB';
  const values = new Map<string, string>();
  const listeners = new Set<() => void>();
  const deferredListResponse = deferred<Response>();
  let accountListRequests = 0;
  const storage: GenerationStoragePort = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
  const locks: LockManagerPort = {
    request: async (_name, _options, callback) => await callback(),
  };
  const snapshot = {
    user: {
      userId: 'user_1',
      email: 'user@example.dev',
      createdAt: '2026-07-30T00:00:00.000Z',
    },
    session: {
      sessionId: 'session_1',
      idleExpiresAt: '2026-07-30T01:00:00.000Z',
      absoluteExpiresAt: '2026-08-06T00:00:00.000Z',
    },
    csrfToken,
  };
  const coordinator = (generation: string) =>
    new SessionRequestCoordinator('https://sceneboard.dev', {
      locks,
      storage,
      fetcher: async (input) => {
        if (String(input).includes('/api/v1/account/api-keys?')) {
          accountListRequests += 1;
          if (accountListRequests > 1) return deferredListResponse.promise;
          return new Response(JSON.stringify({ items: [metadata], nextCursor: null }), {
            status: 200,
          });
        }
        return new Response(JSON.stringify(snapshot), {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            'X-Auth-Generation': generation,
          },
        });
      },
      randomBytes: () => new Uint8Array(16).fill(3),
      notify: () => {
        for (const listener of listeners) listener();
      },
      subscribeGenerationHints(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    });
  const firstTab = coordinator(generationA);
  assert.equal((await firstTab.reconcileSessionGeneration()).kind, 'ok');
  const admitted = await firstTab.bindCurrentGeneration();
  assert.equal(admitted.kind, 'bound');
  if (admitted.kind !== 'bound') return;
  let renderedMetadata: (typeof metadata)[] = [];
  const unsubscribe = firstTab.subscribeGenerationInvalidation(admitted.binding, () => {
    renderedMetadata = [];
  });
  const api = new AccountApiKeyApi(firstTab);
  const initial = await api.list(admitted.binding);
  assert.equal(initial.kind, 'ok');
  if (initial.kind === 'ok') renderedMetadata = initial.value.items as (typeof metadata)[];
  assert.deepEqual(renderedMetadata, [metadata]);
  const deferredList = api.list(admitted.binding);

  const secondTab = coordinator(generationB);
  assert.equal((await secondTab.reconcileSessionGeneration()).kind, 'ok');
  assert.deepEqual(renderedMetadata, []);
  deferredListResponse.resolve(
    new Response(JSON.stringify({ items: [metadata], nextCursor: null }), { status: 200 }),
  );
  const deferredResult = await deferredList;
  if (deferredResult.kind === 'ok')
    renderedMetadata = deferredResult.value.items as (typeof metadata)[];
  assert.deepEqual(deferredResult, { kind: 'stale_attempt' });
  assert.deepEqual(renderedMetadata, []);
  unsubscribe();
});

test('account API-key adapter sends exact closed durations across browser clock skew and rejects drift', async () => {
  const value = setup([
    consumed(201, { apiKey: rawKey, metadata }),
    consumed(201, { apiKey: rawKey, metadata }),
    consumed(201, { apiKey: rawKey, metadata }),
    consumed(201, { apiKey: rawKey, metadata }),
    consumed(201, { apiKey: rawKey, metadata }),
    consumed(201, { apiKey: rawKey, metadata }),
  ]);
  const originalNow = Date.now;
  try {
    for (const browserNow of [0, Date.parse('2099-01-01T00:00:00.000Z')]) {
      Date.now = () => browserNow;
      for (const expiresInDays of [30, 90, 365] as const) {
        assert.equal(
          (
            await value.api.create({
              displayName: 'Automation',
              scopes: ['board:read'],
              expiresInDays,
            })
          ).kind,
          'ok',
        );
      }
    }
  } finally {
    Date.now = originalNow;
  }
  for (const expiresInDays of [29, 30.5, 366]) {
    assert.deepEqual(
      await value.api.create({
        displayName: 'Automation',
        scopes: ['board:read'],
        expiresInDays,
      }),
      { kind: 'invalid_input' },
    );
  }
  assert.deepEqual(
    value.requests.map((request) => request.body),
    [30, 90, 365, 30, 90, 365].map((expiresInDays) => ({
      displayName: 'Automation',
      scopes: ['board:read'],
      expiresInDays,
    })),
  );
});
