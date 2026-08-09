import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  ARTIFACT_REQUEST_CAPABILITIES_V1,
  BOARD_EVENT_TYPES_V1,
  BOARD_LIMITS_V1,
  BOARD_MUTATION_COMMAND_TYPES_V1,
  BOARD_OPERATION_TYPES_V1,
  HITL_KINDS_V1,
  NODE_TYPES_V1,
} from '@sceneboard/board-schema';

import { createBoardMcpServerV1 } from '../../src/server.js';
import {
  API_KEY_TOOL_NAMES_V1,
  BOARD_TOOL_NAMES_V1,
  SAFE_TOOL_NAMES_V1,
} from '../../src/tools/register-tools.js';

test('nearest custom origins never receive ambient or stored API-key authorization', async () => {
  const apiKey = `sbk_v1.${'L'.repeat(22)}.${'M'.repeat(43)}`;
  for (const reference of ['env://SCENEBOARD_API_KEY', 'store://owner'] as const) {
    const root = await mkdtemp(`${tmpdir()}/board-mcp-untrusted-nearest-`);
    const diagnostics: string[] = [];
    const requests: Array<{ url: string; authorization: string | null }> = [];
    try {
      await writeFile(
        join(root, '.board.json'),
        JSON.stringify({
          version: 1,
          baseUrl: 'https://attacker.invalid',
          accessTokenRef: reference,
          authScheme: 'bearer',
          timeoutMs: 30_000,
          profile: 'owner',
          credentialMode: 'api_key',
        }),
        { mode: 0o600 },
      );
      const runtime = await createBoardMcpServerV1({
        argv: [],
        cwd: root,
        env:
          reference === 'env://SCENEBOARD_API_KEY'
            ? { SCENEBOARD_API_KEY: apiKey }
            : { XDG_STATE_HOME: join(root, 'state') },
        fetch: async (input, init) => {
          requests.push({
            url: String(input),
            authorization: new Headers(init?.headers).get('authorization'),
          });
          throw new Error('must not dispatch');
        },
        stderr: (line) => diagnostics.push(line),
      });
      assert.equal(runtime.authenticated, false);
      assert.deepEqual(requests, []);
      assert.equal(
        diagnostics.some((line) => line.includes('config_invalid')),
        true,
      );
      assert.equal(JSON.stringify(diagnostics).includes('attacker.invalid'), false);
      assert.equal(JSON.stringify(diagnostics).includes(apiKey), false);
      await runtime.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test('missing configuration boots only the three safe tools and pairing dispatches no network request', async () => {
  let fetchCalls = 0;
  const diagnostics: string[] = [];
  const runtime = await createBoardMcpServerV1({
    argv: [],
    cwd: await mkdtemp(`${tmpdir()}/board-mcp-unconfigured-`),
    env: {},
    fetch: async () => {
      fetchCalls += 1;
      throw new Error('must not dispatch');
    },
    stderr: (line) => diagnostics.push(line),
  });
  const client = new Client({ name: 'composition test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await runtime.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    assert.deepEqual(
      (await client.listTools()).tools.map((tool) => tool.name).sort(),
      [...SAFE_TOOL_NAMES_V1].sort(),
    );
    const status = await client.callTool({
      name: 'board_connection_status',
      arguments: { boardId: null },
    });
    assert.equal(
      (status.structuredContent as { result: { state: string } }).result.state,
      'not_configured',
    );
    const pairing = await client.callTool({
      name: 'board_pair_request',
      arguments: {
        code: 'SB-ABCDEF-GHJKMN',
        clientName: 'SceneBoard Codex',
        requestedScopes: ['board.read'],
        requestedLifecyclePermissions: [],
      },
    });
    assert.equal(pairing.isError, true);
    const error = (pairing.structuredContent as { error: { value: { code: string } } }).error.value;
    assert.equal(error.code, 'BOARD_MCP_CREDENTIAL_UNAVAILABLE');
    assert.equal(fetchCalls, 0);
  } finally {
    await client.close();
    await runtime.close();
  }
  assert.equal(
    diagnostics.every((line) => !/lcbg_v1|PairingProof|Authorization/.test(line)),
    true,
  );
});

test('unexpected handler failures become one correlated internal error without leaking the exception', async () => {
  const token = `lcbg_v1.${'a'.repeat(22)}.${'b'.repeat(43)}`;
  const runtime = await createBoardMcpServerV1({
    argv: [],
    cwd: await mkdtemp(`${tmpdir()}/board-mcp-internal-`),
    env: {
      BOARD_API_URL: 'http://127.0.0.1:3411',
      SCENEBOARD_ACCESS_TOKEN: token,
    },
    fetch: async () => {
      throw new Error(`private failure ${token}`);
    },
    probeOnStart: false,
    stderr: () => undefined,
  });
  runtime.registry.setProtectedEnabled(true);
  const client = new Client({ name: 'composition test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await runtime.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const result = await client.callTool({ name: 'board_get', arguments: { boardId: 'board_1' } });
    const serialized = JSON.stringify(result);
    assert.equal(result.isError, true);
    assert.equal(serialized.includes(token), false);
    assert.equal(serialized.includes('private failure'), false);
  } finally {
    await client.close();
    await runtime.close();
  }
});

test('server composition propagates tool cancellation through connection HTTP work', async () => {
  const token = `lcbg_v1.${'a'.repeat(22)}.${'b'.repeat(43)}`;
  let requestSignal: AbortSignal | undefined;
  let resolveFetch: ((response: Response) => void) | undefined;
  const runtime = await createBoardMcpServerV1({
    argv: [],
    cwd: await mkdtemp(`${tmpdir()}/board-mcp-cancelled-status-`),
    env: {
      BOARD_API_URL: 'http://127.0.0.1:3411',
      SCENEBOARD_ACCESS_TOKEN: token,
    },
    fetch: (_input, init) =>
      new Promise((resolve) => {
        requestSignal = init?.signal ?? undefined;
        resolveFetch = resolve;
      }),
    probeOnStart: false,
    stderr: () => undefined,
  });
  const client = new Client({ name: 'composition test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await runtime.connect(serverTransport);
  await client.connect(clientTransport);
  const controller = new AbortController();
  try {
    const pending = client.callTool(
      { name: 'board_connection_status', arguments: { boardId: null } },
      undefined,
      { signal: controller.signal },
    );
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort();
    await assert.rejects(pending, (error: unknown) => String(error).includes('AbortError'));
    assert.equal(requestSignal?.aborted, true);
    resolveFetch?.(new Response('{}', { status: 200 }));
  } finally {
    await client.close();
    await runtime.close();
  }
});

test('server composition preserves the backend pairing capability epoch', async () => {
  const token = `lcbg_v1.${'a'.repeat(22)}.${'b'.repeat(43)}`;
  const runtime = await createBoardMcpServerV1({
    argv: [],
    cwd: await mkdtemp(`${tmpdir()}/board-mcp-capability-epoch-`),
    env: {
      BOARD_API_URL: 'http://127.0.0.1:3411',
      SCENEBOARD_ACCESS_TOKEN: token,
    },
    fetch: async (input) => {
      const url = new URL(String(input));
      const requestId = url.searchParams.get('requestId') ?? '';
      return new Response(
        JSON.stringify({
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
            boardIds: ['board_1'],
            lifetime: 'persistent',
            status: 'active',
            activatedAt: '2026-07-16T16:00:00.000Z',
            expiresAt: '2026-08-16T16:00:00.000Z',
          },
          selectedBoard: {
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
            capabilityEpoch: 12,
          },
          versions: { mcpServer: '0.0.0', boardProtocol: '1.0.0', api: 'v1' },
        }),
        {
          status: 200,
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store, private',
            Pragma: 'no-cache',
            Vary: 'Origin, Cookie, Authorization',
            'X-Request-Id': requestId,
          },
        },
      );
    },
    probeOnStart: false,
    stderr: () => undefined,
  });
  const client = new Client({ name: 'composition test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await runtime.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const status = await client.callTool({
      name: 'board_connection_status',
      arguments: { boardId: 'board_1' },
    });
    const result = (status.structuredContent as { result: Record<string, unknown> }).result;
    assert.equal(result.state, 'connected');
    assert.equal(
      (
        result.connection as {
          selectedBoard: { capabilityEpoch: number };
        }
      ).selectedBoard.capabilityEpoch,
      12,
    );
  } finally {
    await client.close();
    await runtime.close();
  }
});

test('terminal authentication failure invalidates the token and shrinks discovery from 30 tools to 3', async () => {
  const token = `lcbg_v1.${'a'.repeat(22)}.${'b'.repeat(43)}`;
  let calls = 0;
  const runtime = await createBoardMcpServerV1({
    argv: [],
    cwd: await mkdtemp(`${tmpdir()}/board-mcp-revoked-`),
    env: {
      BOARD_API_URL: 'http://127.0.0.1:3411',
      SCENEBOARD_ACCESS_TOKEN: token,
    },
    fetch: async (input) => {
      calls += 1;
      const requestId = new URL(String(input)).searchParams.get('requestId') ?? '';
      const headers = {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store, private',
        Pragma: 'no-cache',
        Vary: 'Origin, Cookie, Authorization',
        'X-Request-Id': requestId,
      };
      if (calls === 1)
        return new Response(
          JSON.stringify({
            principal: { principalKind: 'mcp_client', principalId: 'client_1', grantId: 'grant_1' },
            grant: {
              grantId: 'grant_1',
              client: {
                clientId: 'client_1',
                clientName: 'SceneBoard Codex',
                installationFingerprint: 'abcdefghijklmnop',
              },
              scopes: ['board.read'],
              lifecyclePermissions: [],
              boardIds: ['board_1'],
              lifetime: 'persistent',
              status: 'active',
              activatedAt: '2026-07-16T16:00:00.000Z',
              expiresAt: '2026-08-16T16:00:00.000Z',
            },
            selectedBoard: null,
            versions: { mcpServer: '0.0.0', boardProtocol: '1.0.0', api: 'v1' },
          }),
          { status: 200, headers },
        );
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
        { status: 401, headers },
      );
    },
    stderr: () => undefined,
  });
  const client = new Client({ name: 'composition test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await runtime.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    assert.deepEqual(
      (await client.listTools()).tools.map((tool) => tool.name).sort(),
      [...BOARD_TOOL_NAMES_V1].sort(),
    );
    const status = await client.callTool({
      name: 'board_connection_status',
      arguments: { boardId: null },
    });
    assert.equal(
      (status.structuredContent as { result: { state: string } }).result.state,
      'credential_invalid',
    );
    assert.deepEqual(
      (await client.listTools()).tools.map((tool) => tool.name).sort(),
      [...SAFE_TOOL_NAMES_V1].sort(),
    );
  } finally {
    await client.close();
    await runtime.close();
  }
  assert.equal(calls, 2);
});

test('API-key composition exposes owner tools and normalizes invalid rename timestamps', async () => {
  const apiKey = `sbk_v1.${'A'.repeat(22)}.${'B'.repeat(43)}`;
  let renameUpdatedAt = '2026-07-30T01:02:03.004Z';
  const fetchImplementation: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === '/api/v1/mcp/connection') {
      const requestId = url.searchParams.get('requestId') ?? '';
      const boardId = url.searchParams.get('boardId');
      if (boardId === null) assert.equal(url.searchParams.get('authorizationOperation'), null);
      else {
        assert.equal(boardId, 'board_1');
        assert.equal(url.searchParams.get('authorizationOperation'), 'board.rename');
      }
      return new Response(
        JSON.stringify({
          principal: {
            principalKind: 'service',
            principalId: 'key_1',
            grantId: null,
          },
          credential: {
            keyPublicId: 'key_1',
            scopes: ['board:read', 'board:write'],
            status: 'active',
            expiresAt: '2027-07-30T00:00:00.000Z',
          },
          selectedBoard:
            boardId === null
              ? null
              : {
                  board: {
                    boardId,
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
                    grantedCapabilities: [],
                    allowedArtifactRequestCapabilities: [],
                  },
                },
          versions: {
            mcpServer: '0.0.0',
            boardProtocol: '1.0.0',
            api: 'v1',
          },
        }),
        {
          status: 200,
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store, private',
            Pragma: 'no-cache',
            Vary: 'Origin, Cookie, Authorization',
            'X-Request-Id': requestId,
          },
        },
      );
    }
    assert.equal(url.pathname, '/api/v1/boards/board_1/title');
    assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${apiKey}`);
    assert.deepEqual(JSON.parse(String(init?.body)), { title: 'Renamed board' });
    return new Response(
      JSON.stringify({
        boardId: 'board_1',
        title: 'Renamed board',
        updatedAt: renameUpdatedAt,
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
      },
    );
  };
  const runtime = await createBoardMcpServerV1({
    argv: [],
    cwd: await mkdtemp(`${tmpdir()}/board-mcp-api-key-`),
    env: {
      BOARD_API_URL: 'http://127.0.0.1:3411',
      BOARD_CREDENTIAL_MODE: 'api_key',
      BOARD_ACCESS_TOKEN_REF: 'env://SCENEBOARD_API_KEY',
      SCENEBOARD_API_KEY: apiKey,
    },
    fetch: fetchImplementation,
    stderr: () => undefined,
  });
  const client = new Client({ name: 'composition test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await runtime.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    assert.deepEqual(
      (await client.listTools()).tools.map((tool) => tool.name).sort(),
      [...API_KEY_TOOL_NAMES_V1].sort(),
    );
    const status = await client.callTool({
      name: 'board_connection_status',
      arguments: { boardId: null },
    });
    const statusResult = (status.structuredContent as { result: Record<string, unknown> }).result;
    assert.deepEqual(Object.keys(statusResult).sort(), [
      'config',
      'connection',
      'credentialMode',
      'lastErrorCode',
      'retryable',
      'state',
    ]);
    const renamed = await client.callTool({
      name: 'board_rename',
      arguments: { boardId: 'board_1', title: 'Renamed board' },
    });
    assert.equal(renamed.isError, false);
    assert.deepEqual((renamed.structuredContent as { result: Record<string, unknown> }).result, {
      boardId: 'board_1',
      title: 'Renamed board',
      updatedAt: '2026-07-30T01:02:03.004Z',
    });
    for (const invalidTimestamp of ['2026-99-99T99:99:99.999Z', '2026-02-29T01:02:03.004Z']) {
      renameUpdatedAt = invalidTimestamp;
      const invalidRename = await client.callTool({
        name: 'board_rename',
        arguments: { boardId: 'board_1', title: 'Renamed board' },
      });
      assert.equal(invalidRename.isError, true);
      assert.equal(
        (invalidRename.structuredContent as { error: { value: { code: string } } }).error.value
          .code,
        'BOARD_MCP_RESPONSE_INVALID',
      );
    }
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    assert.equal(names.includes('board_pair_request'), false);
    assert.equal(names.includes('sceneboard_media_place'), true);
    assert.equal(names.includes('board_artifact_put'), true);
  } finally {
    await client.close();
    await runtime.close();
  }
});
