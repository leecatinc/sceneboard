import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const repositoryRoot = resolve(import.meta.dirname, '../..');
const pluginRoot = resolve(repositoryRoot, 'sceneboard-mcp/plugins/sceneboard');
const runtime = resolve(pluginRoot, 'runtime/index.js');
const helper = resolve(pluginRoot, 'native/profile-lease-helper');
const digest = resolve(pluginRoot, 'native/profile-lease-helper.sha256');
const launcher = resolve(pluginRoot, 'scripts/launch-sceneboard-mcp.mjs');

test('the public plugin contains an executable reviewed MCP runtime', async () => {
  const [runtimeStatus, helperStatus, helperBytes, expectedDigest] = await Promise.all([
    lstat(runtime),
    lstat(helper),
    readFile(helper),
    readFile(digest, 'utf8'),
  ]);
  assert.equal(runtimeStatus.isFile(), true);
  assert.equal(helperStatus.isFile(), true);
  assert.equal(helperStatus.isSymbolicLink(), false);
  assert.equal(helperStatus.mode & 0o777, 0o500);
  assert.equal(createHash('sha256').update(helperBytes).digest('hex'), expectedDigest.trim());
});

test('a clean plugin launcher exposes the SceneBoard MCP tool surface', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'sceneboard-plugin-runtime-'));
  await writeFile(
    join(projectRoot, '.mcp.json'),
    JSON.stringify({
      mcpServers: {
        sceneboard: {
          command: process.execPath,
          args: [runtime],
          env: {
            BOARD_API_URL: 'http://127.0.0.1:1',
            BOARD_ACCESS_TOKEN_REF: 'env://SCENEBOARD_ACCESS_TOKEN',
            BOARD_TIMEOUT_MS: '1000',
            SCENEBOARD_ACCESS_TOKEN: `lcbg_v1.${'a'.repeat(22)}.${'b'.repeat(43)}`,
          },
        },
      },
    }),
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [launcher],
    cwd: pluginRoot,
    env: { HOME: projectRoot, PWD: projectRoot, SCENEBOARD_PROJECT_ROOT: projectRoot },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'SceneBoard clean plugin QA', version: '1.0.0' });
  let stderr = '';
  transport.stderr?.on('data', (chunk) => {
    stderr += String(chunk);
  });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.equal(
      tools.tools.some((tool) => tool.name === 'board_connection_status'),
      true,
    );
    assert.equal(
      tools.tools.some((tool) => tool.name === 'board_pair_request'),
      true,
    );
  } finally {
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
    await rm(projectRoot, { recursive: true, force: true });
  }
  assert.doesNotMatch(stderr, /production_runtime_unavailable/u);
});
