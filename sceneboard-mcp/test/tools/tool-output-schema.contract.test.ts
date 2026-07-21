import assert from 'node:assert/strict';
import test from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { PairingSessionOwnerV1 } from '../../src/pairing/pairing-session.owner.js';
import type { ProtectedBoardGatewayV1 } from '../../src/tools/protected-board.gateway.js';
import { BOARD_TOOL_ERROR_CODES_V1, registerCoreToolsV1 } from '../../src/tools/register-tools.js';
import { toolOutputSchemaV1 } from '../../src/tools/tool-result.js';

test('manual validation returns a correlated structured failure for invalid tool input', async () => {
  const server = new McpServer({ name: 'SceneBoard', version: '0.0.0' });
  registerCoreToolsV1(server, {
    gateway: { call: async () => ({ connected: false }) } as unknown as ProtectedBoardGatewayV1,
    pairing: {} as PairingSessionOwnerV1,
    connections: { status: async () => ({ ok: true, value: {} }) },
    authenticated: false,
  });
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const result = await client.callTool({ name: 'board_connection_status', arguments: {} });
    assert.equal(result.isError, true);
    const structured = result.structuredContent as Record<string, unknown>;
    assert.equal(structured.ok, false);
    assert.equal(structured.tool, 'board_connection_status');
    assert.match(String(structured.requestId), /^[A-Za-z0-9_-]{22}$/);
    const error = structured.error as { source: string; value: { code: string } };
    assert.equal(error.source, 'mcp');
    assert.equal(error.value.code, 'BOARD_MCP_INPUT_INVALID');
  } finally {
    await client.close();
    await server.close();
  }
});

test('terminal tool output schemas reject wrong result tags, request IDs, metadata, and unreachable errors', () => {
  const schema = toolOutputSchemaV1(
    'board_artifact_put',
    BOARD_TOOL_ERROR_CODES_V1.board_artifact_put,
  );
  const valid = {
    ok: true,
    tool: 'board_artifact_put',
    requestId: 'request_1',
    result: {
      protocolVersion: 1,
      type: 'mutation.result',
      requestId: 'request_1',
      boardId: 'board_1',
      replayed: false,
      eventIds: [],
      result: {
        type: 'artifact.publish',
        artifact: {
          artifact: { artifactId: 'artifact_1', versionId: 'version_1' },
          status: 'ready',
          updatedAt: '2026-07-16T00:00:00.000Z',
          failure: null,
        },
      },
    },
    metadata: null,
  };
  assert.equal(schema.safeParse(valid).success, true);
  assert.equal(
    schema.safeParse({
      ...valid,
      result: { ...valid.result, result: { type: 'artifact.stop' } },
    }).success,
    false,
  );
  assert.equal(
    schema.safeParse({
      ...valid,
      result: { ...valid.result, requestId: 'request_other' },
    }).success,
    false,
  );
  assert.equal(schema.safeParse({ ...valid, metadata: {} }).success, false);
  assert.equal(
    schema.safeParse({
      ok: false,
      tool: 'board_artifact_put',
      requestId: 'request_1',
      error: { source: 'board', value: { code: 'ARTIFACT_NOT_FOUND' } },
    }).success,
    false,
  );
  assert.equal(
    schema.safeParse({
      ok: false,
      tool: 'board_artifact_put',
      requestId: 'request_1',
      error: { source: 'board', value: { code: 'CAPABILITY_DENIED' } },
    }).success,
    true,
  );
});
