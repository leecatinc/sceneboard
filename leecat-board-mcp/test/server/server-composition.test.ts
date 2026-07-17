import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import test from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { createBoardMcpServerV1 } from '../../src/server.js';
import { BOARD_TOOL_NAMES_V1, SAFE_TOOL_NAMES_V1 } from '../../src/tools/register-tools.js';

test('missing configuration boots only the three safe tools and pairing dispatches no network request', async () => {
  let fetchCalls = 0;
  const diagnostics: string[] = [];
  const runtime = await createBoardMcpServerV1({
    argv: [],
    cwd: await mkdtemp(`${tmpdir()}/board-mcp-unconfigured-`),
    env: {},
    fetch: async () => { fetchCalls += 1; throw new Error('must not dispatch'); },
    stderr: (line) => diagnostics.push(line),
  });
  const client = new Client({ name: 'composition test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await runtime.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name).sort(), [...SAFE_TOOL_NAMES_V1].sort());
    const status = await client.callTool({ name: 'board_connection_status', arguments: { boardId: null } });
    assert.equal((status.structuredContent as { result: { state: string } }).result.state, 'not_configured');
    const pairing = await client.callTool({
      name: 'board_pair_request',
      arguments: {
        code: 'ABCDEF-GHJKMN',
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
  assert.equal(diagnostics.every((line) => !/lcbg_v1|PairingProof|Authorization/.test(line)), true);
});

test('unexpected handler failures become one correlated internal error without leaking the exception', async () => {
  const token = `lcbg_v1.${'a'.repeat(22)}.${'b'.repeat(43)}`;
  const runtime = await createBoardMcpServerV1({
    argv: [],
    cwd: await mkdtemp(`${tmpdir()}/board-mcp-internal-`),
    env: {
      BOARD_API_URL: 'http://127.0.0.1:3411',
      LEECAT_BOARD_ACCESS_TOKEN: token,
    },
    fetch: async () => { throw new Error(`private failure ${token}`); },
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

test('terminal authentication failure invalidates the token and shrinks discovery from 21 tools to 3', async () => {
  const token = `lcbg_v1.${'a'.repeat(22)}.${'b'.repeat(43)}`;
  let calls = 0;
  const runtime = await createBoardMcpServerV1({
    argv: [],
    cwd: await mkdtemp(`${tmpdir()}/board-mcp-revoked-`),
    env: {
      BOARD_API_URL: 'http://127.0.0.1:3411',
      LEECAT_BOARD_ACCESS_TOKEN: token,
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
      if (calls === 1) return new Response(JSON.stringify({
        principal: { principalKind: 'mcp_client', principalId: 'client_1', grantId: 'grant_1' },
        grant: {
          grantId: 'grant_1',
          client: { clientId: 'client_1', clientName: 'SceneBoard Codex', installationFingerprint: 'abcdefghijklmnop' },
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
      }), { status: 200, headers });
      return new Response(JSON.stringify({ error: {
        protocolVersion: 1,
        type: 'board.error',
        code: 'UNAUTHENTICATED',
        message: 'Authentication is required',
        category: 'auth',
        retryable: false,
        httpStatusHint: 401,
        details: null,
      } }), { status: 401, headers });
    },
    stderr: () => undefined,
  });
  const client = new Client({ name: 'composition test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await runtime.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name).sort(), [...BOARD_TOOL_NAMES_V1].sort());
    const status = await client.callTool({ name: 'board_connection_status', arguments: { boardId: null } });
    assert.equal((status.structuredContent as { result: { state: string } }).result.state, 'credential_invalid');
    assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name).sort(), [...SAFE_TOOL_NAMES_V1].sort());
  } finally {
    await client.close();
    await runtime.close();
  }
  assert.equal(calls, 2);
});
