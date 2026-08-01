import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ARTIFACT_REQUEST_CAPABILITIES_V1,
  BOARD_EVENT_TYPES_V1,
  BOARD_LIMITS_V1,
  BOARD_MUTATION_COMMAND_TYPES_V1,
  BOARD_OPERATION_TYPES_V1,
  HITL_KINDS_V1,
  NODE_TYPES_V1,
} from '@sceneboard/board-schema';

import { ConnectionHttpClientV1 } from '../../src/connection/connection-http.client.js';
import { ConnectionStatusServiceV1 } from '../../src/connection/connection-status.service.js';
import type { LoadedBoardConfigV1 } from '../../src/config/board-config.js';
import {
  EnvironmentTokenProviderV1,
  type CredentialSnapshotV1,
  type TokenProviderV1,
} from '../../src/credentials/token-provider.js';

const token = `lcbg_v1.${'a'.repeat(22)}.${'b'.repeat(43)}`;
const requestId = 'abcdefghijklmnopqrstuv';
const loaded: LoadedBoardConfigV1 = {
  config: {
    version: 1,
    baseUrl: 'http://127.0.0.1:3411',
    accessTokenRef: 'env://SCENEBOARD_ACCESS_TOKEN',
    authScheme: 'bearer',
    timeoutMs: 30_000,
    profile: 'default',
  },
  source: 'environment',
  path: null,
};

const headers = (extra: Record<string, string> = {}): Record<string, string> => ({
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store, private',
  Pragma: 'no-cache',
  Vary: 'Origin, Cookie, Authorization',
  'X-Request-Id': requestId,
  ...extra,
});

const connection = (selectedBoard: unknown = null, boardIds = ['board_1']) => ({
  principal: { principalKind: 'mcp_client', principalId: 'client_1', grantId: 'grant_1' },
  grant: {
    grantId: 'grant_1',
    client: {
      clientId: 'client_1',
      clientName: 'SceneBoard Codex',
      installationFingerprint: 'abcdefghijklmnop',
    },
    scopes: ['board.read', 'board.write'],
    lifecyclePermissions: ['board.create'],
    boardIds,
    lifetime: 'persistent',
    status: 'active',
    activatedAt: '2026-07-16T16:00:00.000Z',
    expiresAt: '2026-08-16T16:00:00.000Z',
  },
  selectedBoard,
  versions: { mcpServer: '0.0.0', boardProtocol: '1.0.0', api: 'v1' },
});

const selectedBoardFixture = (capabilityEpoch: unknown, extra: Record<string, unknown> = {}) => ({
  board: {
    boardId: 'board_1',
    title: 'Demo',
    createdAt: '2026-07-16T15:00:00.000Z',
    updatedAt: '2026-07-16T16:00:00.000Z',
    archivedAt: null,
    headRevision: {
      revisionId: 'revision_1',
      revisionNumber: 3,
      createdAt: '2026-07-16T16:00:00.000Z',
    },
  },
  capabilities: {
    protocolVersion: 1,
    type: 'board.capabilities',
    schemaVersion: '1.0.0',
    compatibilityMode: 'frozen-major',
    supported: {
      nodeTypes: [...NODE_TYPES_V1],
      commandTypes: [...BOARD_MUTATION_COMMAND_TYPES_V1],
      operationTypes: [...BOARD_OPERATION_TYPES_V1],
      eventTypes: [...BOARD_EVENT_TYPES_V1],
      hitlKinds: [...HITL_KINDS_V1],
      artifactRequestCapabilities: [...ARTIFACT_REQUEST_CAPABILITIES_V1],
    },
    limits: { ...BOARD_LIMITS_V1 },
    grantedCapabilities: ['board.read', 'board.write'],
    allowedArtifactRequestCapabilities: [],
  },
  browserPresence: 'online',
  capabilityEpoch,
  ...extra,
});

const client = (fetchImplementation: typeof fetch) =>
  new ConnectionHttpClientV1({
    baseUrl: loaded.config.baseUrl,
    fetch: fetchImplementation,
    timeoutMs: loaded.config.timeoutMs,
    logger: { log() {} },
  });

const pendingTokenProvider = (
  onSnapshot: (signal: AbortSignal | undefined) => Promise<CredentialSnapshotV1 | null>,
): TokenProviderV1 => ({
  snapshot: onSnapshot,
  invalidate: async () => undefined,
});

test('connection status uses one strict Bearer GET and returns only redacted connected state', async () => {
  let dispatched: Request | null = null;
  const tokens = new EnvironmentTokenProviderV1(token);
  const service = new ConnectionStatusServiceV1(
    loaded,
    tokens,
    client(async (input, init) => {
      dispatched = new Request(input, init);
      return new Response(JSON.stringify(connection()), { status: 200, headers: headers() });
    }),
  );
  const result = await service.status(null, requestId);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.state, 'connected');
  assert.equal((result.value.config as { hasToken: boolean }).hasToken, true);
  assert.equal(JSON.stringify(result.value).includes(token), false);
  const request = dispatched as unknown as Request;
  assert.equal(request.method, 'GET');
  assert.equal(request.headers.get('authorization'), `Bearer ${token}`);
  assert.equal(await request.text(), '');
  assert.equal(new URL(request.url).searchParams.get('requestId'), requestId);
  assert.equal(new URL(request.url).searchParams.has('boardId'), false);
});

test('connection status accepts a create-capable session before its first board exists', async () => {
  const service = new ConnectionStatusServiceV1(
    loaded,
    new EnvironmentTokenProviderV1(token),
    client(
      async () =>
        new Response(JSON.stringify(connection(null, [])), { status: 200, headers: headers() }),
    ),
  );
  const result = await service.status(null, requestId);
  assert.equal(result.ok, true);
  if (!result.ok || result.value.state !== 'connected') return;
  const connected = result.value.connection as ReturnType<typeof connection>;
  assert.deepEqual(connected.grant.boardIds, []);
  assert.equal(connected.selectedBoard, null);
});

test('connection status accepts the complete official grant scope order', async () => {
  const response = connection();
  response.grant.scopes = [
    'board.read',
    'board.write',
    'board.history.read',
    'board.hitl.request',
    'board.hitl.respond',
    'board.media.write',
    'artifact.publish',
    'artifact.control',
  ];
  const service = new ConnectionStatusServiceV1(
    loaded,
    new EnvironmentTokenProviderV1(token),
    client(async () => new Response(JSON.stringify(response), { status: 200, headers: headers() })),
  );
  const result = await service.status(null, requestId);
  assert.equal(result.ok && result.value.state, 'connected');
});

test('targeted connection validates the exact selected board, capabilities, and presence projection', async () => {
  const selectedBoard = selectedBoardFixture(7);
  const service = new ConnectionStatusServiceV1(
    loaded,
    new EnvironmentTokenProviderV1(token),
    client(async (input) => {
      assert.equal(new URL(String(input)).searchParams.get('boardId'), 'board_1');
      return new Response(JSON.stringify(connection(selectedBoard)), {
        status: 200,
        headers: headers(),
      });
    }),
  );
  const result = await service.status('board_1', requestId);
  assert.equal(result.ok && result.value.state, 'connected');
  if (!result.ok || result.value.state !== 'connected') return;
  const connected = result.value.connection as ReturnType<typeof connection>;
  assert.equal((connected.selectedBoard as typeof selectedBoard).board.boardId, 'board_1');
  assert.equal((connected.selectedBoard as typeof selectedBoard).browserPresence, 'online');
  assert.equal((connected.selectedBoard as typeof selectedBoard).capabilityEpoch, 7);
});

test('pairing selected-board epoch accepts safe non-negative integers and rejects wire drift', async () => {
  for (const capabilityEpoch of [0, 9]) {
    const result = await client(
      async () =>
        new Response(JSON.stringify(connection(selectedBoardFixture(capabilityEpoch))), {
          status: 200,
          headers: headers(),
        }),
    ).get('board_1', requestId, token);
    assert.equal(result.ok, true, String(capabilityEpoch));
    if (
      result.ok &&
      result.value.selectedBoard !== null &&
      'capabilityEpoch' in result.value.selectedBoard
    )
      assert.equal(result.value.selectedBoard.capabilityEpoch, capabilityEpoch);
  }

  const missingEpoch = selectedBoardFixture(0);
  delete (missingEpoch as { capabilityEpoch?: unknown }).capabilityEpoch;
  for (const invalid of [
    missingEpoch,
    selectedBoardFixture(-1),
    selectedBoardFixture(1.5),
    selectedBoardFixture(Number.MAX_SAFE_INTEGER + 1),
    selectedBoardFixture('1'),
    selectedBoardFixture(1, { unexpected: true }),
  ]) {
    const result = await client(
      async () =>
        new Response(JSON.stringify(connection(invalid)), { status: 200, headers: headers() }),
    ).get('board_1', requestId, token);
    assert.deepEqual(result, {
      ok: false,
      source: 'local',
      error: { code: 'RESPONSE_INVALID', retryable: false, reason: 'schema' },
    });
  }
});

test('UNAUTHENTICATED invalidates only the used token and becomes credential_invalid state', async () => {
  const tokens = new EnvironmentTokenProviderV1(token);
  const error = {
    protocolVersion: 1,
    type: 'board.error',
    code: 'UNAUTHENTICATED',
    message: 'Authentication is required',
    category: 'auth',
    retryable: false,
    httpStatusHint: 401,
    details: null,
  };
  const service = new ConnectionStatusServiceV1(
    loaded,
    tokens,
    client(
      async () => new Response(JSON.stringify({ error }), { status: 401, headers: headers() }),
    ),
  );
  const first = await service.status(null, requestId);
  assert.equal(first.ok && first.value.state, 'credential_invalid');
  assert.equal(await tokens.snapshot(), null);
  const second = await service.status(null, requestId);
  assert.equal(second.ok && second.value.state, 'credential_missing');
});

test('malformed security headers and duplicate JSON remain closed backend-unavailable states', async () => {
  for (const response of [
    new Response(JSON.stringify(connection()), {
      status: 200,
      headers: headers({ Vary: 'Authorization' }),
    }),
    new Response('{"principal":{},"principal":{}}', { status: 200, headers: headers() }),
  ]) {
    const service = new ConnectionStatusServiceV1(
      loaded,
      new EnvironmentTokenProviderV1(token),
      client(async () => response),
    );
    const result = await service.status(null, requestId);
    assert.equal(result.ok && result.value.state, 'backend_unavailable');
    if (result.ok) assert.equal(result.value.lastErrorCode, 'BOARD_MCP_RESPONSE_INVALID');
  }
});

test('pairing status applies caller cancellation before and during credential snapshots', async () => {
  const preAborted = new AbortController();
  preAborted.abort();
  let snapshotCalls = 0;
  const preAbortedService = new ConnectionStatusServiceV1(
    loaded,
    pendingTokenProvider(async () => {
      snapshotCalls += 1;
      return null;
    }),
    client(async () => {
      throw new Error('must not fetch');
    }),
  );
  const preAbortedResult = await preAbortedService.status(null, requestId, preAborted.signal);
  assert.equal(preAbortedResult.ok, false);
  if (!preAbortedResult.ok) assert.equal(preAbortedResult.value.code, 'BOARD_MCP_CANCELLED');
  assert.equal(snapshotCalls, 0);

  const controller = new AbortController();
  let snapshotSignal: AbortSignal | undefined;
  let resolveSnapshot: ((snapshot: CredentialSnapshotV1 | null) => void) | undefined;
  let fetchCalls = 0;
  const service = new ConnectionStatusServiceV1(
    loaded,
    pendingTokenProvider(
      (signal) =>
        new Promise((resolve) => {
          snapshotSignal = signal;
          resolveSnapshot = resolve;
        }),
    ),
    client(async () => {
      fetchCalls += 1;
      throw new Error('must not fetch');
    }),
  );
  const pending = service.status(null, requestId, controller.signal);
  await Promise.resolve();
  controller.abort();
  const result = await pending;
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.value.code, 'BOARD_MCP_CANCELLED');
  assert.equal(snapshotSignal?.aborted, true);
  resolveSnapshot?.({ version: 1, generation: 'late', accessToken: token });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fetchCalls, 0);
});

test('pairing status timeout covers credential snapshots and cannot settle late as connected', async () => {
  const timeoutLoaded: LoadedBoardConfigV1 = {
    ...loaded,
    config: { ...loaded.config, timeoutMs: 20 },
  };
  let resolveSnapshot: ((snapshot: CredentialSnapshotV1 | null) => void) | undefined;
  let fetchCalls = 0;
  const service = new ConnectionStatusServiceV1(
    timeoutLoaded,
    pendingTokenProvider(
      () =>
        new Promise((resolve) => {
          resolveSnapshot = resolve;
        }),
    ),
    new ConnectionHttpClientV1({
      baseUrl: loaded.config.baseUrl,
      fetch: async () => {
        fetchCalls += 1;
        return new Response(JSON.stringify(connection()), { status: 200, headers: headers() });
      },
      timeoutMs: timeoutLoaded.config.timeoutMs,
      logger: { log() {} },
    }),
  );
  const result = await service.status(null, requestId);
  assert.equal(result.ok && result.value.state, 'backend_unavailable');
  if (result.ok) assert.equal(result.value.lastErrorCode, 'BOARD_MCP_TIMEOUT');
  resolveSnapshot?.({ version: 1, generation: 'late', accessToken: token });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fetchCalls, 0);
});

test('pairing status ignores a late HTTP success after caller cancellation', async () => {
  const controller = new AbortController();
  let resolveFetch: ((response: Response) => void) | undefined;
  const service = new ConnectionStatusServiceV1(
    loaded,
    new EnvironmentTokenProviderV1(token),
    client(
      () =>
        new Promise((resolve) => {
          resolveFetch = resolve;
        }),
    ),
  );
  const pending = service.status(null, requestId, controller.signal);
  await Promise.resolve();
  controller.abort();
  const result = await pending;
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.value.code, 'BOARD_MCP_CANCELLED');
  resolveFetch?.(new Response(JSON.stringify(connection()), { status: 200, headers: headers() }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(result.ok, false);
});

test('pairing status keeps the original deadline while invalidating an unauthorized credential', async () => {
  const timeoutLoaded: LoadedBoardConfigV1 = {
    ...loaded,
    config: { ...loaded.config, timeoutMs: 20 },
  };
  let invalidationSignal: AbortSignal | undefined;
  let invalidated = false;
  const provider: TokenProviderV1 = {
    snapshot: async () => ({ version: 1, generation: 'current', accessToken: token }),
    invalidate: async (_snapshot, signal) => {
      invalidationSignal = signal;
      await new Promise<void>((resolve, reject) => {
        signal?.addEventListener(
          'abort',
          () => {
            reject(signal.reason);
          },
          { once: true },
        );
      });
      invalidated = true;
    },
  };
  const error = {
    protocolVersion: 1,
    type: 'board.error',
    code: 'UNAUTHENTICATED',
    message: 'Authentication is required',
    category: 'auth',
    retryable: false,
    httpStatusHint: 401,
    details: null,
  };
  const service = new ConnectionStatusServiceV1(
    timeoutLoaded,
    provider,
    new ConnectionHttpClientV1({
      baseUrl: loaded.config.baseUrl,
      fetch: async () =>
        new Response(JSON.stringify({ error }), { status: 401, headers: headers() }),
      timeoutMs: timeoutLoaded.config.timeoutMs,
      logger: { log() {} },
    }),
  );
  const result = await service.status(null, requestId);
  assert.equal(result.ok && result.value.state, 'backend_unavailable');
  if (result.ok) assert.equal(result.value.lastErrorCode, 'BOARD_MCP_TIMEOUT');
  assert.equal(invalidationSignal?.aborted, true);
  assert.equal(invalidated, false);
});
