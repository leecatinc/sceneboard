import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import {
  PRODUCTION_API_URL,
  resolveSceneBoardServer,
} from '../../plugins/sceneboard/scripts/sceneboard-mcp-config.mjs';

const pluginRoot = resolve(import.meta.dirname, '../../plugins/sceneboard');

const withProject = async (run: (projectRoot: string) => Promise<void>) => {
  const base = join(tmpdir(), 'sceneboard-plugin-');
  await mkdir(tmpdir(), { recursive: true });
  const projectRoot = await mkdtemp(base);
  try {
    await run(projectRoot);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
};

test('prefers the open project root .mcp.json over Codex configuration', async () => {
  await withProject(async (projectRoot) => {
    await writeFile(
      join(projectRoot, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          sceneboard: {
            command: '/trusted/project/node',
            args: ['/trusted/project/server.js'],
            env: { BOARD_API_URL: 'http://127.0.0.1:3411' },
          },
        },
      }),
    );
    const selected = await resolveSceneBoardServer({
      cwd: pluginRoot,
      pluginRoot,
      environment: { PWD: projectRoot },
      run: () => {
        throw new Error('Codex config must not be read');
      },
    });
    assert.equal(selected.source, 'project_root_mcp_json');
    assert.equal(selected.server.command, '/trusted/project/node');
    assert.equal(selected.server.env.BOARD_API_URL, 'http://127.0.0.1:3411');
  });
});

test('uses the effective Codex project or user config when no root override exists', async () => {
  await withProject(async (projectRoot) => {
    const selected = await resolveSceneBoardServer({
      cwd: projectRoot,
      pluginRoot,
      environment: { BOARD_TEST_SETTING: 'forwarded' },
      run: () => ({
        status: 0,
        stdout: JSON.stringify({
          name: 'sceneboard',
          enabled: true,
          transport: {
            type: 'stdio',
            command: 'sceneboard-mcp',
            args: ['--profile', 'work'],
            env: { BOARD_PROFILE: 'work' },
            env_vars: ['BOARD_TEST_SETTING'],
            cwd: null,
          },
        }),
      }),
    });
    assert.equal(selected.source, 'codex_config_toml');
    assert.equal(selected.server.command, 'sceneboard-mcp');
    assert.deepEqual(selected.server.args, ['--profile', 'work']);
    assert.equal(selected.server.env.BOARD_TEST_SETTING, 'forwarded');
  });
});

test('falls back to the sceneboard.dev production contract without credentials', async () => {
  await withProject(async (projectRoot) => {
    const selected = await resolveSceneBoardServer({
      cwd: projectRoot,
      pluginRoot,
      run: () => ({ status: 1, stdout: '' }),
    });
    assert.equal(selected.source, 'production_default');
    assert.equal(selected.server.env.BOARD_API_URL, PRODUCTION_API_URL);
    assert.equal(selected.server.env.BOARD_CREDENTIAL_MODE, 'pairing');
    assert.equal(selected.server.env.BOARD_ACCESS_TOKEN_REF, 'store://sceneboard');
    assert.equal('SCENEBOARD_ACCESS_TOKEN' in selected.server.env, false);
  });
});

test('production plugin forwards only an explicit API-key mode and reference', async () => {
  await withProject(async (projectRoot) => {
    const selected = await resolveSceneBoardServer({
      cwd: projectRoot,
      pluginRoot,
      environment: {
        BOARD_CREDENTIAL_MODE: 'api_key',
        BOARD_ACCESS_TOKEN_REF: 'env://SCENEBOARD_API_KEY',
        SCENEBOARD_API_KEY: `sbk_v1.${'A'.repeat(22)}.${'B'.repeat(43)}`,
      },
      run: () => ({ status: 1, stdout: '' }),
    });
    assert.equal(selected.source, 'production_default');
    assert.equal(selected.server.env.BOARD_CREDENTIAL_MODE, 'api_key');
    assert.equal(selected.server.env.BOARD_ACCESS_TOKEN_REF, 'env://SCENEBOARD_API_KEY');
    assert.equal('SCENEBOARD_API_KEY' in selected.server.env, false);
  });
});

test('does not recursively select the plugin launcher from Codex config', async () => {
  await withProject(async (projectRoot) => {
    const selected = await resolveSceneBoardServer({
      cwd: projectRoot,
      pluginRoot,
      run: () => ({
        status: 0,
        stdout: JSON.stringify({
          name: 'sceneboard',
          enabled: true,
          transport: {
            type: 'stdio',
            command: 'node',
            args: ['/plugin/scripts/launch-sceneboard-mcp.mjs'],
            env: {},
          },
        }),
      }),
    });
    assert.equal(selected.source, 'production_default');
  });
});

test('fails closed on an invalid project SceneBoard entry', async () => {
  await withProject(async (projectRoot) => {
    await writeFile(
      join(projectRoot, '.mcp.json'),
      JSON.stringify({
        mcpServers: { sceneboard: { command: '', env: {} } },
      }),
    );
    await assert.rejects(
      resolveSceneBoardServer({
        cwd: projectRoot,
        pluginRoot,
        run: () => ({ status: 1, stdout: '' }),
      }),
      /invalid_sceneboard_project_command/,
    );
  });
});

test('rejects an API-key literal in project .mcp.json env', async () => {
  await withProject(async (projectRoot) => {
    await writeFile(
      join(projectRoot, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          sceneboard: {
            command: 'node',
            args: ['/trusted/runtime.js'],
            env: {
              BOARD_CREDENTIAL_MODE: 'api_key',
              SCENEBOARD_API_KEY: `sbk_v1.${'A'.repeat(22)}.${'B'.repeat(43)}`,
            },
          },
        },
      }),
    );
    await assert.rejects(
      resolveSceneBoardServer({
        cwd: projectRoot,
        pluginRoot,
        run: () => ({ status: 1, stdout: '' }),
      }),
      /invalid_sceneboard_project_raw_api_key/,
    );
  });
});

test('rejects a symlinked project-root MCP configuration', async () => {
  await withProject(async (projectRoot) => {
    const target = join(projectRoot, 'linked-mcp.json');
    await writeFile(target, JSON.stringify({ mcpServers: {} }));
    await symlink(target, join(projectRoot, '.mcp.json'));
    await assert.rejects(
      resolveSceneBoardServer({
        cwd: projectRoot,
        pluginRoot,
        run: () => ({ status: 1, stdout: '' }),
      }),
      /invalid_sceneboard_project_config_file/,
    );
  });
});

test('production plugin carries exactly the verified linux-x64-gnu local export helper', async () => {
  const manifestPath = resolve(pluginRoot, 'native/local-export-helper.manifest.json');
  const helperPath = resolve(pluginRoot, 'native/linux-x64-gnu/local-export-helper');
  const digestPath = resolve(pluginRoot, 'native/linux-x64-gnu/local-export-helper.sha256');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  assert.deepEqual(Object.keys(manifest.targets), ['linux-x64-gnu']);
  assert.deepEqual(Object.keys(manifest.targets['linux-x64-gnu']).sort(), [
    'mode',
    'path',
    'sha256',
  ]);
  assert.equal(manifest.targets['linux-x64-gnu'].path, 'linux-x64-gnu/local-export-helper');
  assert.equal(manifest.targets['linux-x64-gnu'].mode, '0500');
  const helperBytes = await readFile(helperPath);
  const digest = createHash('sha256').update(helperBytes).digest('hex');
  assert.equal(manifest.targets['linux-x64-gnu'].sha256, digest);
  assert.equal(await readFile(digestPath, 'utf8'), `${digest}\n`);
  assert.equal((await lstat(helperPath)).mode & 0o777, 0o500);
  assert.equal((await lstat(manifestPath)).mode & 0o777, 0o400);
});
