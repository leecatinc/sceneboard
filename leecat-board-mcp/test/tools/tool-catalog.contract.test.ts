import assert from 'node:assert/strict';
import test from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { PairingSessionOwnerV1 } from '../../src/pairing/pairing-session.owner.js';
import type { ProtectedBoardGatewayV1 } from '../../src/tools/protected-board.gateway.js';
import { BOARD_TOOL_ERROR_CODES_V1, BOARD_TOOL_NAMES_V1, CORE_TOOL_NAMES_V1, registerCoreToolsV1, SAFE_TOOL_NAMES_V1 } from '../../src/tools/register-tools.js';

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
  const gateway = { call: async () => ({ connected: false }) } as unknown as ProtectedBoardGatewayV1;
  const pairing = {} as PairingSessionOwnerV1;
  const connections = {
    status: async () => ({ ok: true as const, value: { state: 'not_configured', config: null, connection: null, lastErrorCode: null } }),
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

test('authenticated discovery contains exactly 15 core tools and no D7/D8 descriptor', async () => {
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

test('terminal readiness publishes exactly 21 tools without aliases and keeps capability denial put-only', async () => {
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
    assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name).sort(), [...BOARD_TOOL_NAMES_V1].sort());
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
    assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name).sort(), [...CORE_TOOL_NAMES_V1].sort());
    registry.setProtectedEnabled(false);
    assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name).sort(), [...SAFE_TOOL_NAMES_V1].sort());
  } finally {
    await client.close();
    await server.close();
  }
});
