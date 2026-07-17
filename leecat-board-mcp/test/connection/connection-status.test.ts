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
} from '@leecat-board/board-schema';

import { ConnectionHttpClientV1 } from '../../src/connection/connection-http.client.js';
import { ConnectionStatusServiceV1 } from '../../src/connection/connection-status.service.js';
import type { LoadedBoardConfigV1 } from '../../src/config/board-config.js';
import { EnvironmentTokenProviderV1 } from '../../src/credentials/token-provider.js';

const token = `lcbg_v1.${'a'.repeat(22)}.${'b'.repeat(43)}`;
const requestId = 'abcdefghijklmnopqrstuv';
const loaded: LoadedBoardConfigV1 = {
  config: {
    version: 1,
    baseUrl: 'http://127.0.0.1:3411',
    accessTokenRef: 'env://LEECAT_BOARD_ACCESS_TOKEN',
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

const connection = (selectedBoard: unknown = null) => ({
  principal: { principalKind: 'mcp_client', principalId: 'client_1', grantId: 'grant_1' },
  grant: {
    grantId: 'grant_1',
    client: { clientId: 'client_1', clientName: 'SceneBoard Codex', installationFingerprint: 'abcdefghijklmnop' },
    scopes: ['board.read', 'board.write'],
    lifecyclePermissions: ['board.create'],
    boardIds: ['board_1'],
    lifetime: 'persistent',
    status: 'active',
    activatedAt: '2026-07-16T16:00:00.000Z',
    expiresAt: '2026-08-16T16:00:00.000Z',
  },
  selectedBoard,
  versions: { mcpServer: '0.0.0', boardProtocol: '1.0.0', api: 'v1' },
});

const client = (fetchImplementation: typeof fetch) => new ConnectionHttpClientV1({
  baseUrl: loaded.config.baseUrl,
  fetch: fetchImplementation,
  timeoutMs: loaded.config.timeoutMs,
  logger: { log() {} },
});

test('connection status uses one strict Bearer GET and returns only redacted connected state', async () => {
  let dispatched: Request | null = null;
  const tokens = new EnvironmentTokenProviderV1(token);
  const service = new ConnectionStatusServiceV1(loaded, tokens, client(async (input, init) => {
    dispatched = new Request(input, init);
    return new Response(JSON.stringify(connection()), { status: 200, headers: headers() });
  }));
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

test('targeted connection validates the exact selected board, capabilities, and presence projection', async () => {
  const selectedBoard = {
    board: {
      boardId: 'board_1',
      title: 'Demo',
      createdAt: '2026-07-16T15:00:00.000Z',
      updatedAt: '2026-07-16T16:00:00.000Z',
      archivedAt: null,
      headRevision: { revisionId: 'revision_1', revisionNumber: 3, createdAt: '2026-07-16T16:00:00.000Z' },
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
  };
  const service = new ConnectionStatusServiceV1(
    loaded,
    new EnvironmentTokenProviderV1(token),
    client(async (input) => {
      assert.equal(new URL(String(input)).searchParams.get('boardId'), 'board_1');
      return new Response(JSON.stringify(connection(selectedBoard)), { status: 200, headers: headers() });
    }),
  );
  const result = await service.status('board_1', requestId);
  assert.equal(result.ok && result.value.state, 'connected');
  if (!result.ok || result.value.state !== 'connected') return;
  const connected = result.value.connection as ReturnType<typeof connection>;
  assert.equal((connected.selectedBoard as typeof selectedBoard).board.boardId, 'board_1');
  assert.equal((connected.selectedBoard as typeof selectedBoard).browserPresence, 'online');
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
  const service = new ConnectionStatusServiceV1(loaded, tokens, client(async () => (
    new Response(JSON.stringify({ error }), { status: 401, headers: headers() })
  )));
  const first = await service.status(null, requestId);
  assert.equal(first.ok && first.value.state, 'credential_invalid');
  assert.equal(await tokens.snapshot(), null);
  const second = await service.status(null, requestId);
  assert.equal(second.ok && second.value.state, 'credential_missing');
});

test('malformed security headers and duplicate JSON remain closed backend-unavailable states', async () => {
  for (const response of [
    new Response(JSON.stringify(connection()), { status: 200, headers: headers({ Vary: 'Authorization' }) }),
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
