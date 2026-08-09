import assert from 'node:assert/strict';
import test from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { ConnectionHttpClientV1 } from '../../src/connection/connection-http.client.js';
import { ApiKeyConnectionStatusServiceV1 } from '../../src/connection/connection-status.service.js';
import type { LoadedBoardConfigV1 } from '../../src/config/board-config.js';
import { ApiKeyTokenProviderV1 } from '../../src/credentials/token-provider.js';
import type { PairingSessionOwnerV1 } from '../../src/pairing/pairing-session.owner.js';
import type { ProtectedBoardGatewayV1 } from '../../src/tools/protected-board.gateway.js';
import {
  BOARD_TOOL_ERROR_CODES_V1,
  BOARD_TOOL_NAMES_V1,
  CORE_TOOL_NAMES_V1,
  API_KEY_TOOL_NAMES_V1,
  registerCoreToolsV1,
  SAFE_TOOL_NAMES_V1,
} from '../../src/tools/register-tools.js';
import { toolOutputSchemaV1 } from '../../src/tools/tool-result.js';

const downstreamNames = [
  'board_artifact_get',
  'board_artifact_put',
  'board_artifact_stop',
  'board_interaction_request',
  'board_interaction_status',
  'board_interaction_respond',
];

const fixture = async (authenticated: boolean) => {
  const server = new McpServer({ name: 'SceneBoard', version: '0.0.0' });
  const gateway = {
    call: async () => ({ connected: false }),
  } as unknown as ProtectedBoardGatewayV1;
  const pairing = {} as PairingSessionOwnerV1;
  const connections = {
    status: async () => ({
      ok: true as const,
      value: { state: 'not_configured', config: null, connection: null, lastErrorCode: null },
    }),
  };
  const registry = registerCoreToolsV1(server, { gateway, pairing, connections, authenticated });
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { server, client, registry };
};

test('unauthenticated discovery contains exactly three safe tools and strict explicit inputs', async () => {
  const { server, client } = await fixture(false);
  try {
    const listed = await client.listTools();
    assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), [...SAFE_TOOL_NAMES_V1].sort());
    const connection = listed.tools.find((tool) => tool.name === 'board_connection_status');
    assert.deepEqual(connection?.inputSchema.required, ['boardId']);
    assert.equal(connection?.inputSchema.additionalProperties, false);
  } finally {
    await client.close();
    await server.close();
  }
});

test('authenticated discovery contains exactly 24 core tools and no D7/D8 descriptor', async () => {
  const { server, client } = await fixture(true);
  try {
    const names = (await client.listTools()).tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, [...CORE_TOOL_NAMES_V1].sort());
    const nameSet = new Set<string>(names);
    for (const name of downstreamNames) assert.equal(nameSet.has(name), false);
  } finally {
    await client.close();
    await server.close();
  }
});

test('terminal readiness publishes exactly 30 tools without aliases and keeps capability denial put-only', async () => {
  const server = new McpServer({ name: 'SceneBoard', version: '0.0.0' });
  const registry = registerCoreToolsV1(server, {
    gateway: { call: async () => ({ connected: false }) } as unknown as ProtectedBoardGatewayV1,
    pairing: {} as PairingSessionOwnerV1,
    connections: { status: async () => ({ ok: true, value: {} }) },
    authenticated: true,
    downstreamReady: true,
  });
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    assert.deepEqual(
      (await client.listTools()).tools.map((tool) => tool.name).sort(),
      [...BOARD_TOOL_NAMES_V1].sort(),
    );
    assert.deepEqual(registry.names, BOARD_TOOL_NAMES_V1);
    assert.equal(BOARD_TOOL_NAMES_V1.includes('board_artifact_remove' as never), false);
    assert.equal(BOARD_TOOL_NAMES_V1.includes('board_interaction_cancel' as never), false);
    for (const [tool, codes] of Object.entries(BOARD_TOOL_ERROR_CODES_V1)) {
      assert.equal(codes.includes('CAPABILITY_DENIED' as never), tool === 'board_artifact_put');
    }
  } finally {
    await client.close();
    await server.close();
  }
});

test('registry activation changes discovery without registering aliases or stubs', async () => {
  const { server, client, registry } = await fixture(false);
  try {
    registry.setProtectedEnabled(true);
    assert.deepEqual(
      (await client.listTools()).tools.map((tool) => tool.name).sort(),
      [...CORE_TOOL_NAMES_V1].sort(),
    );
    registry.setProtectedEnabled(false);
    assert.deepEqual(
      (await client.listTools()).tools.map((tool) => tool.name).sort(),
      [...SAFE_TOOL_NAMES_V1].sort(),
    );
  } finally {
    await client.close();
    await server.close();
  }
});

test('API-key mode registers only connection status and the exact owner-tool cover', async () => {
  const server = new McpServer({ name: 'SceneBoard', version: '0.0.0' });
  const registry = registerCoreToolsV1(server, {
    gateway: {
      call: async () => ({ connected: false }),
      renameBoard: async () => ({ connected: false }),
    } as unknown as ProtectedBoardGatewayV1,
    pairing: {} as PairingSessionOwnerV1,
    connections: { status: async () => ({ ok: true, value: {} }) },
    authenticated: true,
    downstreamReady: true,
    credentialMode: 'api_key',
  });
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    assert.deepEqual(registry.names, API_KEY_TOOL_NAMES_V1);
    assert.deepEqual(
      (await client.listTools()).tools.map((tool) => tool.name).sort(),
      [...API_KEY_TOOL_NAMES_V1].sort(),
    );
  } finally {
    await client.close();
    await server.close();
  }
});

test('terminal export authentication failure immediately shrinks API-key discovery', async () => {
  let publishCalls = 0;
  const server = new McpServer({ name: 'SceneBoard', version: '0.0.0' });
  const registry = registerCoreToolsV1(server, {
    gateway: {
      call: async () => ({ connected: false }),
      renameBoard: async () => ({ connected: false }),
      exportBoard: async () => ({
        connected: true as const,
        value: {
          ok: false as const,
          source: 'board' as const,
          error: {
            code: 'EXPORT_UNAUTHENTICATED',
            message: 'Authentication is required',
            retryable: false,
          },
        },
      }),
    } as unknown as ProtectedBoardGatewayV1,
    pairing: {} as PairingSessionOwnerV1,
    connections: { status: async () => ({ ok: true, value: {} }) },
    authenticated: true,
    credentialMode: 'api_key',
    localExports: {
      preflight: () => ({ ok: true, value: { reservation: 'test' } }),
      publish: async () => {
        publishCalls += 1;
        throw new Error('must not publish');
      },
      release: () => undefined,
    } as never,
  });
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    assert.deepEqual(
      (await client.listTools()).tools.map((tool) => tool.name).sort(),
      API_KEY_TOOL_NAMES_V1.filter((name) => !downstreamNames.includes(name)).sort(),
    );
    const result = await client.callTool({
      name: 'board_export',
      arguments: {
        boardId: 'board_1',
        revisionId: 'revision_1',
        format: 'pdf',
        outputFile: '/tmp/sceneboard-export-not-written.pdf',
      },
    });
    assert.equal(result.isError, true);
    assert.equal(publishCalls, 0);
    assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name).sort(), [
      'board_connection_status',
    ]);
    assert.deepEqual(registry.names, API_KEY_TOOL_NAMES_V1);
  } finally {
    await client.close();
    await server.close();
  }
});

test('connection status and rename output schemas enforce exact success contracts', () => {
  const statusSchema = toolOutputSchemaV1(
    'board_connection_status',
    BOARD_TOOL_ERROR_CODES_V1.board_connection_status,
  );
  const pairingMissing = {
    ok: true,
    tool: 'board_connection_status',
    requestId: 'request_1',
    result: {
      state: 'credential_missing',
      config: {
        source: 'environment',
        profile: 'default',
        baseOrigin: 'https://sceneboard.dev',
        timeoutMs: 30_000,
        hasToken: false,
      },
      connection: null,
      lastErrorCode: null,
    },
    metadata: null,
  };
  const apiKeyMissing = {
    ...pairingMissing,
    result: {
      credentialMode: 'api_key',
      state: 'credential_missing',
      config: { source: 'env', referenceConfigured: false },
      connection: null,
      lastErrorCode: 'API_KEY_CREDENTIAL_MISSING',
      retryable: false,
    },
  };
  assert.equal(statusSchema.safeParse(pairingMissing).success, true);
  assert.equal(statusSchema.safeParse(apiKeyMissing).success, true);
  const apiKeyConnected = {
    ...apiKeyMissing,
    result: {
      credentialMode: 'api_key',
      state: 'connected',
      config: { source: 'env', referenceConfigured: true },
      connection: {
        principal: { principalKind: 'service', principalId: 'key_1', grantId: null },
        credential: {
          keyPublicId: 'key_1',
          scopes: ['board:read'],
          status: 'active',
          expiresAt: '2999-01-01T00:00:00.000Z',
        },
        selectedBoard: null,
        versions: { mcpServer: '0.0.0', boardProtocol: '1.0.0', api: 'v1' },
      },
      lastErrorCode: null,
      retryable: false,
    },
  };
  assert.equal(statusSchema.safeParse(apiKeyConnected).success, true);
  assert.equal(
    statusSchema.safeParse({
      ...apiKeyConnected,
      result: {
        ...apiKeyConnected.result,
        connection: {
          ...apiKeyConnected.result.connection,
          principal: {
            ...apiKeyConnected.result.connection.principal,
            principalId: 'key_other',
          },
        },
      },
    }).success,
    false,
  );
  for (const invalid of [
    { ...apiKeyMissing, result: { ...apiKeyMissing.result, extra: true } },
    {
      ...apiKeyMissing,
      result: {
        credentialMode: 'api_key',
        state: 'credential_missing',
        config: { source: 'env', referenceConfigured: false },
        connection: null,
        retryable: false,
      },
    },
    { ...apiKeyMissing, result: { ...apiKeyMissing.result, retryable: 'false' } },
    { ...apiKeyMissing, metadata: {} },
  ])
    assert.equal(statusSchema.safeParse(invalid).success, false);

  const renameSchema = toolOutputSchemaV1('board_rename', BOARD_TOOL_ERROR_CODES_V1.board_rename);
  const rename = {
    ok: true,
    tool: 'board_rename',
    requestId: 'request_1',
    result: {
      boardId: 'board_1',
      title: 'Renamed board',
      updatedAt: '2026-07-30T01:02:03.004Z',
    },
    metadata: null,
  };
  assert.equal(renameSchema.safeParse(rename).success, true);
  for (const invalid of [
    { ...rename, result: { ...rename.result, extra: true } },
    { ...rename, result: { title: rename.result.title, updatedAt: rename.result.updatedAt } },
    { ...rename, result: { ...rename.result, title: 7 } },
    { ...rename, result: { ...rename.result, updatedAt: '2026-07-30T01:02:03Z' } },
    { ...rename, result: { ...rename.result, updatedAt: '2026-99-99T99:99:99.999Z' } },
    { ...rename, result: { ...rename.result, updatedAt: '2026-02-29T01:02:03.004Z' } },
    { ...rename, metadata: {} },
  ])
    assert.equal(renameSchema.safeParse(invalid).success, false);
});

test('accepted API-key status survives output validation after expiry while a later decode rejects it', async () => {
  const validationInstant = Date.parse('2026-08-02T00:00:00.000Z');
  const expiryInstant = validationInstant + 1;
  const apiKey = `sbk_v1.${'A'.repeat(22)}.${'B'.repeat(43)}`;
  const projection = {
    principal: { principalKind: 'service', principalId: 'key_1', grantId: null },
    credential: {
      keyPublicId: 'key_1',
      scopes: ['board:read'],
      status: 'active',
      expiresAt: new Date(expiryInstant).toISOString(),
    },
    selectedBoard: null,
    versions: { mcpServer: '0.0.0', boardProtocol: '1.0.0', api: 'v1' },
  };
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
  let decoderNow = validationInstant;
  const connectionClient = new ConnectionHttpClientV1({
    baseUrl: loaded.config.baseUrl,
    timeoutMs: loaded.config.timeoutMs,
    fetch: async (input) => {
      const requestId = new URL(String(input)).searchParams.get('requestId') ?? '';
      return new Response(JSON.stringify(projection), {
        status: 200,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store, private',
          Pragma: 'no-cache',
          Vary: 'Origin, Cookie, Authorization',
          'X-Request-Id': requestId,
        },
      });
    },
    logger: { log() {} },
    now: () => decoderNow,
  });
  const connections = new ApiKeyConnectionStatusServiceV1(
    loaded,
    new ApiKeyTokenProviderV1({ kind: 'environment', apiKey }),
    connectionClient,
  );
  const server = new McpServer({ name: 'SceneBoard', version: '0.0.0' });
  registerCoreToolsV1(server, {
    gateway: { call: async () => ({ connected: false }) } as unknown as ProtectedBoardGatewayV1,
    pairing: {} as PairingSessionOwnerV1,
    connections,
    authenticated: false,
    credentialMode: 'api_key',
  });
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const originalDateNow = Date.now;
  Date.now = () => expiryInstant;
  try {
    assert.deepEqual(
      (await client.listTools()).tools.map((tool) => tool.name),
      ['board_connection_status'],
    );
    const status = await client.callTool({
      name: 'board_connection_status',
      arguments: { boardId: null },
    });
    assert.equal(status.isError, false);
    assert.equal(
      (status.structuredContent as { result: { state: string } }).result.state,
      'connected',
    );
    assert.deepEqual(
      (await client.listTools()).tools.map((tool) => tool.name).sort(),
      API_KEY_TOOL_NAMES_V1.filter((name) => !downstreamNames.includes(name)).sort(),
    );

    decoderNow = expiryInstant;
    const expiredDecode = await connectionClient.get(
      null,
      'request_after_expiry',
      apiKey,
      undefined,
      'api_key',
    );
    assert.equal(expiredDecode.ok, false);
    if (!expiredDecode.ok) {
      assert.equal(expiredDecode.source, 'local');
      assert.equal(expiredDecode.error.code, 'RESPONSE_INVALID');
    }
  } finally {
    Date.now = originalDateNow;
    await client.close();
    await server.close();
  }
});
