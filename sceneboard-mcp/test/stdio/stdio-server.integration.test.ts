import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import { BOARD_TOOL_NAMES_V1 } from '../../src/tools/register-tools.js';

const token = `lcbg_v1.${'a'.repeat(22)}.${'b'.repeat(43)}`;
const require = createRequire(import.meta.url);

test('real stdio process publishes the authenticated terminal 21-tool surface and shuts down without secret output', async () => {
  const requests: Array<{ authorization: string | undefined; boardId: string | null }> = [];
  const backend = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const requestId = url.searchParams.get('requestId') ?? '';
    requests.push({
      authorization: request.headers.authorization,
      boardId: url.searchParams.get('boardId'),
    });
    const body = JSON.stringify({
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
      selectedBoard: null,
      versions: { mcpServer: '0.0.0', boardProtocol: '1.0.0', api: 'v1' },
    });
    response.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store, private',
      Pragma: 'no-cache',
      Vary: 'Origin, Cookie, Authorization',
      'X-Request-Id': requestId,
      'Content-Length': Buffer.byteLength(body),
    });
    response.end(body);
  });
  await new Promise<void>((resolve, reject) => {
    backend.once('error', reject);
    backend.listen(0, '127.0.0.1', () => resolve());
  });
  const address = backend.address();
  assert.ok(address !== null && typeof address !== 'string');
  const packageRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
  const tsxCli = require.resolve('tsx/cli');
  const home = await mkdtemp(join(tmpdir(), 'board-mcp-stdio-'));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [tsxCli, join(packageRoot, 'src', 'index.ts')],
    cwd: packageRoot,
    env: {
      HOME: home,
      BOARD_API_URL: `http://127.0.0.1:${address.port}`,
      SCENEBOARD_ACCESS_TOKEN: token,
    },
    stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr?.on('data', (chunk) => {
    stderr += String(chunk);
  });
  const client = new Client({ name: 'SceneBoard stdio test', version: '1.0.0' });
  try {
    await client.connect(transport);
    const names = (await client.listTools()).tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, [...BOARD_TOOL_NAMES_V1].sort());
    const status = await client.callTool({
      name: 'board_connection_status',
      arguments: { boardId: null },
    });
    assert.equal(status.isError, false);
    const structured = status.structuredContent as {
      result: { state: string; connection: { selectedBoard: unknown } };
    };
    assert.equal(structured.result.state, 'connected');
    assert.equal(structured.result.connection.selectedBoard, null);
  } finally {
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
    await new Promise<void>((resolve) => backend.close(() => resolve()));
  }
  assert.equal(requests.length, 2);
  assert.deepEqual(
    requests.map((request) => request.boardId),
    [null, null],
  );
  assert.equal(
    requests.every((request) => request.authorization === `Bearer ${token}`),
    true,
  );
  assert.equal(stderr.includes(token), false);
  assert.equal(stderr.includes('Authorization'), false);
});
