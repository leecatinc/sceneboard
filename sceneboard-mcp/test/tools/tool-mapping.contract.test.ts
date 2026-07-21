import assert from 'node:assert/strict';
import test from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { PairingSessionOwnerV1 } from '../../src/pairing/pairing-session.owner.js';
import type { ProtectedBoardGatewayV1 } from '../../src/tools/protected-board.gateway.js';
import { registerCoreToolsV1 } from '../../src/tools/register-tools.js';

test('a protected call without a credential returns the closed not-connected branch', async () => {
  const server = new McpServer({ name: 'SceneBoard', version: '0.0.0' });
  registerCoreToolsV1(server, {
    gateway: { call: async () => ({ connected: false }) } as unknown as ProtectedBoardGatewayV1,
    pairing: {} as PairingSessionOwnerV1,
    connections: { status: async () => ({ ok: true, value: {} }) },
    authenticated: true,
  });
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const result = await client.callTool({ name: 'board_get', arguments: { boardId: 'board_1' } });
    const structured = result.structuredContent as Record<string, unknown>;
    const error = structured.error as { source: string; value: { code: string } };
    assert.equal(result.isError, true);
    assert.equal(error.source, 'mcp');
    assert.equal(error.value.code, 'BOARD_MCP_NOT_CONNECTED');
  } finally {
    await client.close();
    await server.close();
  }
});
