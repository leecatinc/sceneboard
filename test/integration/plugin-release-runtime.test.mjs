import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  access,
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const repositoryRoot = resolve(import.meta.dirname, '../..');
const canonicalPluginRoot = resolve(repositoryRoot, 'sceneboard-mcp/plugins/sceneboard');
const pluginRoot = await readFile(resolve(canonicalPluginRoot, '.sceneboard-current'), 'utf8').then(
  async (pointer) => {
    const releaseName = pointer.trim();
    assert.equal(pointer, `${releaseName}\n`);
    assert.match(releaseName, /^generation-[A-Za-z0-9-]+$/u);
    const releaseRoot = resolve(canonicalPluginRoot, '.sceneboard-releases', releaseName);
    const status = await lstat(releaseRoot);
    assert.equal(status.isDirectory(), true);
    assert.equal(status.isSymbolicLink(), false);
    return releaseRoot;
  },
  (error) => {
    if (error?.code === 'ENOENT') return canonicalPluginRoot;
    throw error;
  },
);
const runtime = resolve(pluginRoot, 'runtime/index.js');
const helper = resolve(pluginRoot, 'native/profile-lease-helper');
const digest = resolve(pluginRoot, 'native/profile-lease-helper.sha256');
const exportHelper = resolve(pluginRoot, 'native/linux-x64-gnu/local-export-helper');
const exportManifest = resolve(pluginRoot, 'native/local-export-helper.manifest.json');
const launcher = resolve(pluginRoot, 'scripts/launch-sceneboard-mcp.mjs');
const apiKey = `sbk_v1.${'R'.repeat(22)}.${'S'.repeat(43)}`;
const accountApiKeyScopes = [
  'board:archive',
  'board:create',
  'board:read',
  'board:write',
  'export:read',
  'history:read',
];
const defaultCapabilities = JSON.parse(
  await readFile(
    resolve(
      repositoryRoot,
      'packages/board-schema/test/fixtures/valid/capabilities-default.v1.json',
    ),
    'utf8',
  ),
);

const createPublisherConcurrencyFixture = async (projectRoot) => {
  const fixtureRoot = join(projectRoot, 'publisher-concurrency');
  const script = join(fixtureRoot, 'scripts/build-sceneboard-plugin.mjs');
  const runtimeSource = join(fixtureRoot, 'sceneboard-mcp/src/index.ts');
  const nativeSourceRoot = join(fixtureRoot, 'sceneboard-mcp/native');
  const fixturePluginRoot = join(fixtureRoot, 'sceneboard-mcp/plugins/sceneboard');
  const nativeRoot = join(fixturePluginRoot, 'native');
  const binaryRoot = join(fixtureRoot, 'bin');
  await Promise.all([
    mkdir(dirname(script), { recursive: true }),
    mkdir(dirname(runtimeSource), { recursive: true }),
    mkdir(nativeSourceRoot, { recursive: true }),
    mkdir(binaryRoot, { recursive: true }),
    mkdir(join(fixturePluginRoot, 'runtime'), { recursive: true }),
    mkdir(join(fixturePluginRoot, 'scripts'), { recursive: true }),
    mkdir(join(fixturePluginRoot, 'skills/sceneboard'), { recursive: true }),
    mkdir(join(nativeRoot, 'linux-x64-gnu'), { recursive: true }),
  ]);
  const compiler = join(binaryRoot, 'cc');
  await Promise.all([
    copyFile(resolve(repositoryRoot, 'scripts/build-sceneboard-plugin.mjs'), script),
    symlink(resolve(repositoryRoot, 'node_modules'), join(fixtureRoot, 'node_modules'), 'dir'),
    writeFile(
      compiler,
      `#!${process.execPath}\nimport { readFileSync, writeFileSync } from 'node:fs';\nconst outputIndex = process.argv.indexOf('-o');\nconst source = process.argv.at(-1);\nif (outputIndex < 0 || source === undefined) process.exit(2);\nwriteFileSync(process.argv[outputIndex + 1], Buffer.concat([Buffer.from('fixture-native\\n'), readFileSync(source)]));\n`,
    ),
    writeFile(runtimeSource, 'process.stdout.write("publisher-v1");\n'),
    writeFile(join(nativeSourceRoot, 'profile-lease-helper.c'), 'int main(void) { return 0; }\n'),
    writeFile(join(nativeSourceRoot, 'local-export-helper.c'), 'int main(void) { return 0; }\n'),
    writeFile(join(fixturePluginRoot, '.mcp.json'), '{}\n'),
    writeFile(join(fixturePluginRoot, 'scripts/fixture.mjs'), 'export {};\n'),
    writeFile(join(fixturePluginRoot, 'skills/sceneboard/SKILL.md'), '# Fixture\n'),
    writeFile(join(fixturePluginRoot, 'runtime/index.js'), 'process.stdout.write("seed");\n'),
    writeFile(join(nativeRoot, 'profile-lease-helper'), 'seed'),
    writeFile(join(nativeRoot, 'profile-lease-helper.sha256'), 'seed\n'),
    writeFile(join(nativeRoot, 'linux-x64-gnu/local-export-helper'), 'seed'),
    writeFile(join(nativeRoot, 'linux-x64-gnu/local-export-helper.sha256'), 'seed\n'),
    writeFile(join(nativeRoot, 'local-export-helper.manifest.json'), '{}\n'),
  ]);
  await Promise.all([
    chmod(compiler, 0o500),
    chmod(join(nativeRoot, 'profile-lease-helper'), 0o500),
    chmod(join(nativeRoot, 'profile-lease-helper.sha256'), 0o400),
    chmod(join(nativeRoot, 'linux-x64-gnu/local-export-helper'), 0o500),
    chmod(join(nativeRoot, 'linux-x64-gnu/local-export-helper.sha256'), 0o400),
    chmod(join(nativeRoot, 'local-export-helper.manifest.json'), 0o400),
  ]);
  return { fixtureRoot, script, runtimeSource, fixturePluginRoot, binaryRoot };
};

const startPublisher = (fixture, fault) => {
  const child = spawn(process.execPath, [fixture.script], {
    cwd: fixture.fixtureRoot,
    env: {
      PATH: `${fixture.binaryRoot}:${process.env.PATH ?? '/usr/bin:/bin'}`,
      SCENEBOARD_PLUGIN_PUBLISH_TEST_CLEANUP: 'immediate',
      ...(fault === undefined ? {} : { SCENEBOARD_PLUGIN_PUBLISH_TEST_FAULT: fault }),
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => (stdout += chunk));
  child.stderr.on('data', (chunk) => (stderr += chunk));
  const result = new Promise((resolveResult, rejectResult) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      rejectResult(new Error('publisher concurrency fixture timed out'));
    }, 20_000);
    child.once('error', (error) => {
      clearTimeout(timeout);
      rejectResult(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timeout);
      resolveResult({ code, signal, stdout, stderr });
    });
  });
  const checkpoint =
    fault === undefined
      ? Promise.resolve()
      : new Promise((resolveCheckpoint, rejectCheckpoint) => {
          const timeout = setTimeout(
            () => rejectCheckpoint(new Error('publisher checkpoint timed out')),
            10_000,
          );
          child.once('message', (message) => {
            if (message?.event !== 'sceneboard_plugin_after_activate') return;
            clearTimeout(timeout);
            resolveCheckpoint();
          });
        });
  return { child, checkpoint, result };
};

const finishPublisher = async (publisher) => {
  const result = await publisher.result;
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.signal, null);
  assert.deepEqual(JSON.parse(result.stdout), { status: 'BUILT', runtime: 'runtime/index.js' });
};

const connectionHeaders = (requestId) => ({
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store, private',
  Pragma: 'no-cache',
  Vary: 'Origin, Cookie, Authorization',
  'X-Request-Id': requestId,
});

const sendConnectionJson = (request, response, status, value) => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  const body = JSON.stringify(value);
  response.writeHead(status, {
    ...connectionHeaders(url.searchParams.get('requestId') ?? ''),
    'Content-Length': Buffer.byteLength(body),
  });
  response.end(body);
  return url;
};

const apiKeyConnection = ({
  boardId = null,
  expiresAt = '2999-08-02T00:00:00.000Z',
  principalId = 'key_1',
  keyPublicId = 'key_1',
  scopes = [...accountApiKeyScopes],
} = {}) => ({
  principal: { principalKind: 'service', principalId, grantId: null },
  credential: { keyPublicId, scopes, status: 'active', expiresAt },
  selectedBoard:
    boardId === null
      ? null
      : {
          board: {
            boardId,
            title: 'Synthetic board',
            createdAt: '2026-07-16T15:00:00.000Z',
            updatedAt: '2026-07-16T16:00:00.000Z',
            archivedAt: null,
            headRevision: {
              revisionId: 'revision_1',
              revisionNumber: 1,
              createdAt: '2026-07-16T16:00:00.000Z',
            },
          },
          capabilities: structuredClone(defaultCapabilities),
        },
  versions: { mcpServer: '0.0.0', boardProtocol: '1.0.0', api: 'v1' },
});

const pairingConnection = {
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
    expiresAt: '2999-08-16T16:00:00.000Z',
  },
  selectedBoard: null,
  versions: { mcpServer: '0.0.0', boardProtocol: '1.0.0', api: 'v1' },
};

const boardError = (code) => {
  const definitions = {
    UNAUTHENTICATED: [401, 'Authentication is required', 'auth', false, null],
    FORBIDDEN: [403, 'Forbidden', 'auth', false, null],
    BOARD_NOT_FOUND: [404, 'Board not found', 'not_found', false, null],
    RATE_LIMITED: [429, 'Rate limited', 'rate_limit', true, { retryAfterSeconds: 1 }],
    SERVICE_UNAVAILABLE: [
      503,
      'Service unavailable',
      'availability',
      true,
      { retryAfterSeconds: null },
    ],
    INTERNAL_ERROR: [500, 'Internal error', 'internal', false, null],
  };
  const [httpStatusHint, message, category, retryable, details] = definitions[code];
  return {
    status: httpStatusHint,
    value: {
      error: {
        protocolVersion: 1,
        type: 'board.error',
        code,
        message,
        category,
        retryable,
        httpStatusHint,
        details,
      },
    },
  };
};

const createRuntimeFixture = async (root) => {
  const fixturePluginRoot = join(root, 'plugin');
  const fixtureRuntimeRoot = join(fixturePluginRoot, 'runtime');
  const fixtureNativeRoot = join(fixturePluginRoot, 'native');
  const fixtureExportRoot = join(fixtureNativeRoot, 'linux-x64-gnu');
  await Promise.all([
    mkdir(fixtureRuntimeRoot, { recursive: true }),
    mkdir(fixtureExportRoot, { recursive: true }),
  ]);
  const fixtureRuntime = join(fixtureRuntimeRoot, 'index.js');
  const fixtureExportHelper = join(fixtureExportRoot, 'local-export-helper');
  const fixtureManifest = join(fixtureNativeRoot, 'local-export-helper.manifest.json');
  await Promise.all([
    copyFile(runtime, fixtureRuntime),
    copyFile(exportHelper, fixtureExportHelper),
    copyFile(exportManifest, fixtureManifest),
  ]);
  await Promise.all([
    chmod(fixtureRuntime, 0o644),
    chmod(fixtureExportHelper, 0o500),
    chmod(fixtureManifest, 0o400),
  ]);
  return fixtureRuntime;
};

const withApiKeyRuntime = async (backendHandler, run) => {
  const root = await mkdtemp(join(tmpdir(), 'sceneboard-release-runtime-'));
  const fixtureRuntime = await createRuntimeFixture(root);
  const backend = createServer(backendHandler);
  await new Promise((resolveListen, reject) => {
    backend.once('error', reject);
    backend.listen(0, '127.0.0.1', resolveListen);
  });
  const address = backend.address();
  assert(address !== null && typeof address !== 'string');
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fixtureRuntime],
    cwd: root,
    env: {
      HOME: root,
      BOARD_API_URL: `http://127.0.0.1:${address.port}`,
      BOARD_CREDENTIAL_MODE: 'api_key',
      BOARD_ACCESS_TOKEN_REF: 'env://SCENEBOARD_API_KEY',
      BOARD_TIMEOUT_MS: '1000',
      SCENEBOARD_API_KEY: apiKey,
    },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'SceneBoard release runtime regression', version: '1.0.0' });
  let stderr = '';
  transport.stderr?.on('data', (chunk) => {
    stderr += String(chunk);
  });
  try {
    await client.connect(transport);
    await run({ client, root });
  } finally {
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
    backend.closeAllConnections();
    await new Promise((resolveClose) => backend.close(resolveClose));
    await rm(root, { recursive: true, force: true });
  }
  assert.equal(stderr.includes(apiKey), false);
};

test('the public plugin contains an executable reviewed MCP runtime', async () => {
  const [
    runtimeStatus,
    runtimeBytes,
    canonicalRuntimeBytes,
    helperStatus,
    helperBytes,
    expectedDigest,
  ] = await Promise.all([
    lstat(runtime),
    readFile(runtime),
    readFile(resolve(canonicalPluginRoot, 'runtime/index.js')),
    lstat(helper),
    readFile(helper),
    readFile(digest, 'utf8'),
  ]);
  assert.equal(runtimeStatus.isFile(), true);
  assert.deepEqual(runtimeBytes, canonicalRuntimeBytes);
  assert.equal(runtimeBytes.includes('EXPORT_PUBLICATION_SETTLEMENT_TIMEOUT_MS_V1'), true);
  assert.equal(runtimeBytes.includes('awaitAfterAbort'), true);
  assert.equal(helperStatus.isFile(), true);
  assert.equal(helperStatus.isSymbolicLink(), false);
  assert.equal(helperStatus.mode & 0o777, 0o500);
  assert.equal(createHash('sha256').update(helperBytes).digest('hex'), expectedDigest.trim());
});

test('canonical, plugin, and selected local export helpers have identical integrity metadata', async () => {
  const nativeRoots = [
    resolve(repositoryRoot, 'sceneboard-mcp/native'),
    resolve(canonicalPluginRoot, 'native'),
    resolve(pluginRoot, 'native'),
  ];
  const artifacts = await Promise.all(
    nativeRoots.map(async (nativeRoot) => {
      const helperPath = resolve(nativeRoot, 'linux-x64-gnu/local-export-helper');
      const [helperBytes, digestBytes, manifestBytes, helperStatus] = await Promise.all([
        readFile(helperPath),
        readFile(resolve(nativeRoot, 'linux-x64-gnu/local-export-helper.sha256')),
        readFile(resolve(nativeRoot, 'local-export-helper.manifest.json')),
        lstat(helperPath),
      ]);
      return { helperBytes, digestBytes, manifestBytes, helperStatus };
    }),
  );
  for (const artifact of artifacts) {
    assert.deepEqual(artifact.helperBytes, artifacts[0].helperBytes);
    assert.deepEqual(artifact.digestBytes, artifacts[0].digestBytes);
    assert.deepEqual(artifact.manifestBytes, artifacts[0].manifestBytes);
    assert.equal(artifact.helperStatus.isFile(), true);
    assert.equal(artifact.helperStatus.isSymbolicLink(), false);
    assert.equal(artifact.helperStatus.mode & 0o777, 0o500);
  }
  const digestValue = createHash('sha256').update(artifacts[0].helperBytes).digest('hex');
  assert.equal(artifacts[0].digestBytes.toString('utf8'), `${digestValue}\n`);
  assert.equal(
    JSON.parse(artifacts[0].manifestBytes.toString('utf8')).targets['linux-x64-gnu'].sha256,
    digestValue,
  );
});

test('three completing publishers cannot retire or remove the pointer-selected generation', async (context) => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'sceneboard-publisher-lock-'));
  context.after(() => rm(projectRoot, { recursive: true, force: true }));
  const fixture = await createPublisherConcurrencyFixture(projectRoot);
  await finishPublisher(startPublisher(fixture));

  await writeFile(fixture.runtimeSource, 'process.stdout.write("publisher-v2");\n');
  const firstStale = startPublisher(fixture, 'pause-after-activate');
  await firstStale.checkpoint;

  await writeFile(fixture.runtimeSource, 'process.stdout.write("publisher-v3");\n');
  const secondStale = startPublisher(fixture, 'pause-after-activate');
  await secondStale.checkpoint;

  await writeFile(fixture.runtimeSource, 'process.stdout.write("publisher-v4");\n');
  await finishPublisher(startPublisher(fixture));
  const pointerPath = join(fixture.fixturePluginRoot, '.sceneboard-current');
  const selectedName = (await readFile(pointerPath, 'utf8')).trim();
  const selectedRoot = join(fixture.fixturePluginRoot, '.sceneboard-releases', selectedName);

  firstStale.child.send('resume');
  await finishPublisher(firstStale);
  secondStale.child.send('resume');
  await finishPublisher(secondStale);

  assert.equal((await readFile(pointerPath, 'utf8')).trim(), selectedName);
  assert.equal((await lstat(selectedRoot)).isDirectory(), true);
  await assert.rejects(
    () => lstat(join(selectedRoot, '.sceneboard-retired')),
    (error) => error?.code === 'ENOENT',
  );
  assert.equal(
    (await readFile(join(selectedRoot, 'runtime/index.js'), 'utf8')).includes('publisher-v4'),
    true,
  );
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

test('the production bundle rejects wrong-family, mismatched-ID, and expired API-key connections', async () => {
  const invalidConnections = [
    pairingConnection,
    apiKeyConnection({ principalId: 'key_other' }),
    apiKeyConnection({ expiresAt: '1970-01-01T00:00:00.000Z' }),
  ];
  for (const invalidConnection of invalidConnections) {
    await withApiKeyRuntime(
      (request, response) => {
        sendConnectionJson(request, response, 200, invalidConnection);
      },
      async ({ client }) => {
        const status = await client.callTool({
          name: 'board_connection_status',
          arguments: { boardId: null },
        });
        assert.equal(status.isError, false);
        const result = status.structuredContent.result;
        assert.equal(result.state, 'backend_unavailable');
        assert.equal(result.connection, null);
        assert.equal(result.lastErrorCode, 'API_KEY_BACKEND_RESPONSE_INVALID');
        assert.equal(result.retryable, true);
      },
    );
  }
});

test('the production bundle binds every targeted API-key preflight and omits list/create targets', async () => {
  let connectionCalls = 0;
  let downstreamCalls = 0;
  const preflights = [];
  await withApiKeyRuntime(
    (request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (url.pathname !== '/api/v1/mcp/connection') {
        downstreamCalls += 1;
        response.writeHead(500).end();
        return;
      }
      connectionCalls += 1;
      if (connectionCalls === 1) {
        sendConnectionJson(request, response, 200, apiKeyConnection());
        return;
      }
      preflights.push({
        boardId: url.searchParams.get('boardId'),
        operation: url.searchParams.get('authorizationOperation'),
      });
      const error = boardError('FORBIDDEN');
      sendConnectionJson(request, response, error.status, error.value);
    },
    async ({ client, root }) => {
      const invalidOutput = join(root, 'invalid-null-revision.pdf');
      const invalid = await client.callTool({
        name: 'board_export',
        arguments: {
          boardId: 'board_1',
          revisionId: null,
          format: 'pdf',
          outputFile: invalidOutput,
        },
      });
      assert.equal(invalid.isError, true);
      assert.equal(connectionCalls, 1);
      assert.equal(preflights.length, 0);
      assert.equal(
        await access(invalidOutput).then(
          () => true,
          () => false,
        ),
        false,
      );
      const baseMutation = {
        boardId: 'board_1',
        expectedRevisionId: 'revision_1',
        idempotencyKey: 'idempotency-key-1',
      };
      const calls = [
        ['board_list', { cursor: null, limit: 1, includeArchived: false }, null, null],
        ['board_create', { title: 'Board', idempotencyKey: 'idempotency-key-1' }, null, null],
        ['board_get', { boardId: 'board_1' }, 'board_1', 'board.get'],
        ['board_scene_get', { boardId: 'board_1', revisionId: null }, 'board_1', 'board.get'],
        [
          'board_scene_get',
          { boardId: 'board_1', revisionId: 'revision_1' },
          'board_1',
          'history.get',
        ],
        ['board_document_get', { boardId: 'board_1', revisionId: null }, 'board_1', 'board.get'],
        [
          'board_document_get',
          { boardId: 'board_1', revisionId: 'revision_1' },
          'board_1',
          'history.get',
        ],
        ['board_rename', { boardId: 'board_1', title: 'Renamed' }, 'board_1', 'board.rename'],
        [
          'board_archive',
          { boardId: 'board_1', confirm: true, idempotencyKey: 'idempotency-key-1' },
          'board_1',
          'board.archive',
        ],
        ['board_capabilities_get', { boardId: 'board_1' }, 'board_1', 'capabilities.get'],
        [
          'board_scene_replace',
          { ...baseMutation, scene: { protocolVersion: 1, type: 'scene', root: null } },
          'board_1',
          'scene.replace',
        ],
        [
          'board_scene_patch',
          { ...baseMutation, operations: [{ type: 'replace_root', root: null }] },
          'board_1',
          'scene.replace',
        ],
        ['board_scene_clear', baseMutation, 'board_1', 'scene.clear'],
        [
          'board_document_replace',
          { ...baseMutation, document: {} },
          'board_1',
          'document.replace',
        ],
        ['board_page_add', { ...baseMutation, page: {}, index: 0 }, 'board_1', 'document.replace'],
        ['board_page_remove', { ...baseMutation, pageId: 'page_1' }, 'board_1', 'document.replace'],
        [
          'board_page_reorder',
          { ...baseMutation, pageId: 'page_1', toIndex: 0 },
          'board_1',
          'document.replace',
        ],
        [
          'board_page_update',
          { ...baseMutation, pageId: 'page_1', title: 'Page' },
          'board_1',
          'document.replace',
        ],
        [
          'board_page_default_set',
          { ...baseMutation, pageId: 'page_1' },
          'board_1',
          'document.replace',
        ],
        [
          'board_history_list',
          { boardId: 'board_1', cursor: null, limit: 1 },
          'board_1',
          'history.list',
        ],
        [
          'board_history_get',
          { boardId: 'board_1', revisionId: 'revision_1' },
          'board_1',
          'history.get',
        ],
        [
          'board_history_restore',
          { ...baseMutation, revisionId: 'revision_0', confirm: true },
          'board_1',
          'scene.restore',
        ],
        [
          'board_export',
          {
            boardId: 'board_1',
            revisionId: 'revision_1',
            format: 'pdf',
            outputFile: join(root, 'denied-export.pdf'),
          },
          'board_1',
          'export.render',
        ],
      ];
      for (const [name, argumentsValue] of calls) {
        const result = await client.callTool({ name, arguments: argumentsValue });
        assert.equal(result.isError, true, name);
      }
      assert.deepEqual(
        preflights,
        calls.map(([, , boardId, operation]) => ({ boardId, operation })),
      );
    },
  );
  assert.equal(downstreamCalls, 0);
});

test('the production bundle maps every export preflight failure and terminally disables discovery', async () => {
  const cases = [
    ['FORBIDDEN', 'EXPORT_FORBIDDEN'],
    ['BOARD_NOT_FOUND', 'EXPORT_NOT_FOUND'],
    ['RATE_LIMITED', 'EXPORT_RATE_LIMITED'],
    ['SERVICE_UNAVAILABLE', 'EXPORT_RENDERER_UNAVAILABLE'],
    ['INTERNAL_ERROR', 'EXPORT_INTERNAL_ERROR'],
    ['UNAUTHENTICATED', 'EXPORT_UNAUTHENTICATED'],
  ];
  let connectionCalls = 0;
  let downstreamCalls = 0;
  await withApiKeyRuntime(
    (request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (url.pathname !== '/api/v1/mcp/connection') {
        downstreamCalls += 1;
        response.writeHead(500).end();
        return;
      }
      connectionCalls += 1;
      if (connectionCalls === 1) {
        sendConnectionJson(request, response, 200, apiKeyConnection());
        return;
      }
      const [code] = cases[connectionCalls - 2];
      const error = boardError(code);
      sendConnectionJson(request, response, error.status, error.value);
    },
    async ({ client, root }) => {
      for (const [index, [, expected]] of cases.entries()) {
        const result = await client.callTool({
          name: 'board_export',
          arguments: {
            boardId: 'board_1',
            revisionId: 'revision_1',
            format: 'pdf',
            outputFile: join(root, `preflight-denied-${index}.pdf`),
          },
        });
        assert.equal(result.isError, true);
        assert.equal(result.structuredContent.error.source, 'board');
        assert.equal(result.structuredContent.error.value.code, expected);
      }
      assert.deepEqual(
        (await client.listTools()).tools.map((tool) => tool.name),
        ['board_connection_status'],
      );
    },
  );
  assert.equal(downstreamCalls, 0);
});

test('the production bundle treats export-endpoint authentication as terminal discovery failure', async () => {
  let connectionCalls = 0;
  let exportCalls = 0;
  await withApiKeyRuntime(
    (request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (url.pathname === '/api/v1/mcp/connection') {
        connectionCalls += 1;
        sendConnectionJson(
          request,
          response,
          200,
          apiKeyConnection({ boardId: connectionCalls === 1 ? null : 'board_1' }),
        );
        return;
      }
      assert.equal(url.pathname, '/api/v1/boards/board_1/exports');
      exportCalls += 1;
      const body = JSON.stringify({
        ok: false,
        error: {
          code: 'EXPORT_UNAUTHENTICATED',
          message: 'Authentication is required',
          retryable: false,
        },
      });
      response.writeHead(401, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
      });
      response.end(body);
    },
    async ({ client, root }) => {
      const result = await client.callTool({
        name: 'board_export',
        arguments: {
          boardId: 'board_1',
          revisionId: 'revision_1',
          format: 'pdf',
          outputFile: join(root, 'terminal-export.pdf'),
        },
      });
      assert.equal(result.isError, true);
      assert.equal(result.structuredContent.error.source, 'board');
      assert.equal(result.structuredContent.error.value.code, 'EXPORT_UNAUTHENTICATED');
      assert.deepEqual(
        (await client.listTools()).tools.map((tool) => tool.name),
        ['board_connection_status'],
      );
    },
  );
  assert.equal(exportCalls, 1);
});

test('the production bundle cancels a stalled export download before local publication', async () => {
  let connectionCalls = 0;
  let markExportStarted;
  const exportStarted = new Promise((resolveStarted) => {
    markExportStarted = resolveStarted;
  });
  let markExportClosed;
  const exportClosed = new Promise((resolveClosed) => {
    markExportClosed = resolveClosed;
  });
  await withApiKeyRuntime(
    (request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (url.pathname === '/api/v1/mcp/connection') {
        connectionCalls += 1;
        sendConnectionJson(
          request,
          response,
          200,
          apiKeyConnection({ boardId: connectionCalls === 1 ? null : 'board_1' }),
        );
        return;
      }
      assert.equal(url.pathname, '/api/v1/boards/board_1/exports');
      response.writeHead(200, {
        'Content-Type': 'application/pdf',
        'Content-Length': '1024',
      });
      response.write('%PDF-');
      response.once('close', () => markExportClosed());
      markExportStarted();
    },
    async ({ client, root }) => {
      const outputFile = join(root, 'cancelled-export.pdf');
      const controller = new AbortController();
      const pending = client.callTool(
        {
          name: 'board_export',
          arguments: {
            boardId: 'board_1',
            revisionId: 'revision_1',
            format: 'pdf',
            outputFile,
          },
        },
        undefined,
        { signal: controller.signal },
      );
      try {
        await Promise.race([
          exportStarted,
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('export download did not start')), 2_000),
          ),
        ]);
      } catch (error) {
        controller.abort();
        await pending.catch(() => undefined);
        throw error;
      }
      controller.abort();
      await assert.rejects(pending, (error) => String(error).includes('AbortError'));
      await Promise.race([
        exportClosed,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('stalled export request was not cancelled')), 2_000),
        ),
      ]);
      assert.equal(
        await access(outputFile).then(
          () => true,
          () => false,
        ),
        false,
      );
    },
  );
});
