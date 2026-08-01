import assert from 'node:assert/strict';
import test from 'node:test';

import { ApiKeyConnectionStatusServiceV1 } from '../../src/connection/connection-status.service.js';
import { ConnectionHttpClientV1 } from '../../src/connection/connection-http.client.js';
import type { LoadedBoardConfigV1 } from '../../src/config/board-config.js';
import {
  ApiKeyTokenProviderV1,
  type CredentialSnapshotV1,
  type TokenProviderV1,
} from '../../src/credentials/token-provider.js';

const apiKey = `sbk_v1.${'A'.repeat(22)}.${'B'.repeat(43)}`;
const requestId = 'abcdefghijklmnopqrstuv';
const loaded: LoadedBoardConfigV1 = {
  config: {
    version: 1,
    baseUrl: 'http://127.0.0.1:3411',
    accessTokenRef: 'env://SCENEBOARD_API_KEY',
    authScheme: 'bearer',
    timeoutMs: 30_000,
    profile: 'owner',
    credentialMode: 'api_key',
  },
  source: 'environment',
  path: null,
};

const responseHeaders = (): Record<string, string> => ({
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store, private',
  Pragma: 'no-cache',
  Vary: 'Origin, Cookie, Authorization',
  'X-Request-Id': requestId,
});

const connection = {
  principal: {
    principalKind: 'service',
    principalId: 'service_1',
    grantId: null,
  },
  credential: {
    keyPublicId: 'key_1',
    scopes: ['board:read', 'board:write'],
    status: 'active',
    expiresAt: '2027-07-30T00:00:00.000Z',
  },
  selectedBoard: null,
  versions: { mcpServer: '0.0.0', boardProtocol: '1.0.0', api: 'v1' },
};

const service = (
  token: string | undefined,
  fetchImplementation: typeof fetch,
): ApiKeyConnectionStatusServiceV1 =>
  new ApiKeyConnectionStatusServiceV1(
    loaded,
    new ApiKeyTokenProviderV1({ kind: 'environment', apiKey: token }),
    new ConnectionHttpClientV1({
      baseUrl: loaded.config.baseUrl,
      fetch: fetchImplementation,
      timeoutMs: loaded.config.timeoutMs,
      logger: { log() {} },
    }),
  );

test('API-key status has the exact six-key missing and connected union arms', async () => {
  const missing = await service(undefined, async () => {
    throw new Error('must not fetch');
  }).status(null, requestId);
  assert.equal(missing.ok, true);
  if (!missing.ok) return;
  assert.deepEqual(Object.keys(missing.value).sort(), [
    'config',
    'connection',
    'credentialMode',
    'lastErrorCode',
    'retryable',
    'state',
  ]);
  assert.deepEqual(missing.value, {
    credentialMode: 'api_key',
    state: 'credential_missing',
    config: { source: 'env', referenceConfigured: false },
    connection: null,
    lastErrorCode: 'API_KEY_CREDENTIAL_MISSING',
    retryable: false,
  });

  const connected = await service(
    apiKey,
    async () =>
      new Response(JSON.stringify(connection), {
        status: 200,
        headers: responseHeaders(),
      }),
  ).status(null, requestId);
  assert.equal(connected.ok, true);
  if (!connected.ok) return;
  assert.equal(connected.value.state, 'connected');
  assert.equal(connected.value.credentialMode, 'api_key');
  assert.deepEqual(connected.value.config, {
    source: 'env',
    referenceConfigured: true,
  });
  assert.deepEqual(connected.value.connection, connection);
  assert.equal(JSON.stringify(connected.value).includes(apiKey), false);
});

test('API-key invalid, backend unavailable, and invalid response arms remain exact', async () => {
  const invalid = await service('not-a-key', async () => {
    throw new Error('must not fetch');
  }).status(null, requestId);
  assert.equal(invalid.ok && invalid.value.state, 'credential_invalid');
  if (invalid.ok) {
    assert.equal(invalid.value.lastErrorCode, 'API_KEY_CREDENTIAL_INVALID');
    assert.equal(invalid.value.retryable, false);
  }

  const unavailable = await service(apiKey, async () => {
    throw new Error('offline');
  }).status(null, requestId);
  assert.equal(unavailable.ok && unavailable.value.state, 'backend_unavailable');
  if (unavailable.ok) {
    assert.equal(unavailable.value.lastErrorCode, 'API_KEY_BACKEND_UNAVAILABLE');
    assert.equal(unavailable.value.retryable, true);
  }

  const malformed = await service(
    apiKey,
    async () => new Response('{}', { status: 200, headers: responseHeaders() }),
  ).status(null, requestId);
  assert.equal(malformed.ok && malformed.value.state, 'backend_unavailable');
  if (malformed.ok) {
    assert.equal(malformed.value.lastErrorCode, 'API_KEY_BACKEND_RESPONSE_INVALID');
    assert.equal(malformed.value.retryable, true);
  }
});

test('API-key 401 keeps the current process in invalid state without rereading the source', async () => {
  const provider = new ApiKeyTokenProviderV1({
    kind: 'environment',
    apiKey,
  });
  let calls = 0;
  const status = new ApiKeyConnectionStatusServiceV1(
    loaded,
    provider,
    new ConnectionHttpClientV1({
      baseUrl: loaded.config.baseUrl,
      timeoutMs: loaded.config.timeoutMs,
      logger: { log() {} },
      fetch: async () => {
        calls += 1;
        return new Response(
          JSON.stringify({
            error: {
              protocolVersion: 1,
              type: 'board.error',
              code: 'UNAUTHENTICATED',
              message: 'Authentication is required',
              category: 'auth',
              retryable: false,
              httpStatusHint: 401,
              details: null,
            },
          }),
          { status: 401, headers: responseHeaders() },
        );
      },
    }),
  );
  const first = await status.status(null, requestId);
  const second = await status.status(null, requestId);
  assert.equal(first.ok && first.value.state, 'credential_invalid');
  assert.equal(second.ok && second.value.state, 'credential_invalid');
  if (second.ok) {
    assert.deepEqual(second.value.config, {
      source: 'env',
      referenceConfigured: true,
    });
  }
  assert.equal(calls, 1);
});

test('selected-board 404 remains a board failure outside the API-key status union', async () => {
  const result = await service(
    apiKey,
    async () =>
      new Response(
        JSON.stringify({
          error: {
            protocolVersion: 1,
            type: 'board.error',
            code: 'BOARD_NOT_FOUND',
            message: 'Board not found',
            category: 'not_found',
            retryable: false,
            httpStatusHint: 404,
            details: null,
          },
        }),
        { status: 404, headers: responseHeaders() },
      ),
  ).status('board_missing', requestId);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.source, 'board');
    assert.equal(result.value.code, 'BOARD_NOT_FOUND');
  }
});

test('API-key status applies caller cancellation before and during credential snapshots', async () => {
  const preAborted = new AbortController();
  preAborted.abort();
  let snapshotCalls = 0;
  const neverFetch = new ConnectionHttpClientV1({
    baseUrl: loaded.config.baseUrl,
    fetch: async () => {
      throw new Error('must not fetch');
    },
    timeoutMs: loaded.config.timeoutMs,
    logger: { log() {} },
  });
  const provider = {
    snapshot: async () => {
      snapshotCalls += 1;
      return null;
    },
    invalidate: async () => undefined,
  } satisfies TokenProviderV1;
  const preAbortedResult = await new ApiKeyConnectionStatusServiceV1(
    loaded,
    provider,
    neverFetch,
  ).status(null, requestId, preAborted.signal);
  assert.equal(preAbortedResult.ok, false);
  if (!preAbortedResult.ok) assert.equal(preAbortedResult.value.code, 'BOARD_MCP_CANCELLED');
  assert.equal(snapshotCalls, 0);

  const controller = new AbortController();
  let snapshotSignal: AbortSignal | undefined;
  let resolveSnapshot: ((snapshot: CredentialSnapshotV1 | null) => void) | undefined;
  const pendingProvider = {
    snapshot: (signal?: AbortSignal) =>
      new Promise<CredentialSnapshotV1 | null>((resolve) => {
        snapshotSignal = signal;
        resolveSnapshot = resolve;
      }),
    invalidate: async () => undefined,
  } satisfies TokenProviderV1;
  const pending = new ApiKeyConnectionStatusServiceV1(loaded, pendingProvider, neverFetch).status(
    null,
    requestId,
    controller.signal,
  );
  await Promise.resolve();
  controller.abort();
  const result = await pending;
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.value.code, 'BOARD_MCP_CANCELLED');
  assert.equal(snapshotSignal?.aborted, true);
  resolveSnapshot?.({ version: 1, generation: 'late', accessToken: apiKey });
});

test('API-key status timeout covers credential snapshots', async () => {
  const timeoutLoaded: LoadedBoardConfigV1 = {
    ...loaded,
    config: { ...loaded.config, timeoutMs: 20 },
  };
  const provider = {
    snapshot: () => new Promise<CredentialSnapshotV1 | null>(() => undefined),
    invalidate: async () => undefined,
  } satisfies TokenProviderV1;
  const result = await new ApiKeyConnectionStatusServiceV1(
    timeoutLoaded,
    provider,
    new ConnectionHttpClientV1({
      baseUrl: loaded.config.baseUrl,
      fetch: async () => {
        throw new Error('must not fetch');
      },
      timeoutMs: timeoutLoaded.config.timeoutMs,
      logger: { log() {} },
    }),
  ).status(null, requestId);
  assert.equal(result.ok && result.value.state, 'backend_unavailable');
  if (result.ok) {
    assert.equal(result.value.lastErrorCode, 'API_KEY_BACKEND_UNAVAILABLE');
    assert.equal(result.value.retryable, true);
  }
});

test('API-key status keeps the original deadline while invalidating an unauthorized credential', async () => {
  const timeoutLoaded: LoadedBoardConfigV1 = {
    ...loaded,
    config: { ...loaded.config, timeoutMs: 20 },
  };
  let invalidationSignal: AbortSignal | undefined;
  let invalidated = false;
  const provider: TokenProviderV1 = {
    snapshot: async () => ({ version: 1, generation: 'current', accessToken: apiKey }),
    invalidate: async (_snapshot, signal) => {
      invalidationSignal = signal;
      await new Promise<void>((resolve, reject) => {
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
      invalidated = true;
    },
  };
  const result = await new ApiKeyConnectionStatusServiceV1(
    timeoutLoaded,
    provider,
    new ConnectionHttpClientV1({
      baseUrl: loaded.config.baseUrl,
      fetch: async () =>
        new Response(
          JSON.stringify({
            error: {
              protocolVersion: 1,
              type: 'board.error',
              code: 'UNAUTHENTICATED',
              message: 'Authentication is required',
              category: 'auth',
              retryable: false,
              httpStatusHint: 401,
              details: null,
            },
          }),
          { status: 401, headers: responseHeaders() },
        ),
      timeoutMs: timeoutLoaded.config.timeoutMs,
      logger: { log() {} },
    }),
  ).status(null, requestId);
  assert.equal(result.ok && result.value.state, 'backend_unavailable');
  if (result.ok) assert.equal(result.value.lastErrorCode, 'API_KEY_BACKEND_UNAVAILABLE');
  assert.equal(invalidationSignal?.aborted, true);
  assert.equal(invalidated, false);
});
