import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { BoardConfigError } from '../../src/config/board-config.js';
import { discoverBoardConfigV1 } from '../../src/config/config-discovery.js';

const validConfig = {
  version: 1,
  baseUrl: 'http://127.0.0.1:3001',
  accessTokenRef: 'env://SCENEBOARD_ACCESS_TOKEN',
  authScheme: 'bearer',
  timeoutMs: 30_000,
  profile: 'default',
};

const makeRoot = async (): Promise<string> => mkdtemp(join(tmpdir(), 'board-mcp-config-'));

test('config discovery selects explicit, environment, nearest, user, then environment fallback', async () => {
  const root = await makeRoot();
  const explicit = join(root, 'explicit.json');
  const fromEnv = join(root, 'env.json');
  const nested = join(root, 'project', 'child');
  const userRoot = join(root, 'xdg');
  const userConfig = join(userRoot, 'leecat-board', 'board.json');
  await mkdir(nested, { recursive: true });
  await mkdir(join(userRoot, 'leecat-board'), { recursive: true });
  for (const path of [explicit, fromEnv, userConfig]) {
    await writeFile(path, JSON.stringify(validConfig), { mode: 0o600 });
  }
  await writeFile(
    join(root, 'project', '.board.json'),
    JSON.stringify({ ...validConfig, baseUrl: 'https://sceneboard.dev' }),
    { mode: 0o600 },
  );

  const processResult = await discoverBoardConfigV1({
    argv: [`--config=${explicit}`],
    cwd: nested,
    env: { BOARD_CONFIG: fromEnv, XDG_CONFIG_HOME: userRoot },
  });
  assert.equal(processResult.source, 'process_option');

  const envResult = await discoverBoardConfigV1({
    argv: [],
    cwd: nested,
    env: { BOARD_CONFIG: fromEnv },
  });
  assert.equal(envResult.source, 'board_config_env');

  const nearestResult = await discoverBoardConfigV1({
    argv: [],
    cwd: nested,
    env: { XDG_CONFIG_HOME: userRoot },
  });
  assert.equal(nearestResult.source, 'nearest_board_file');
  assert.equal(nearestResult.config.baseUrl, 'https://sceneboard.dev');

  const userResult = await discoverBoardConfigV1({
    argv: [],
    cwd: root,
    env: { XDG_CONFIG_HOME: userRoot },
  });
  assert.equal(userResult.source, 'user_config_file');

  const fallbackRoot = await makeRoot();
  const fallback = await discoverBoardConfigV1({
    argv: [],
    cwd: fallbackRoot,
    env: { BOARD_API_URL: 'https://sceneboard.dev' },
  });
  assert.equal(fallback.source, 'environment');
  assert.equal(fallback.path, null);
  assert.equal(fallback.config.accessTokenRef, 'env://SCENEBOARD_ACCESS_TOKEN');
  assert.equal(fallback.config.profile, 'default');
  assert.equal(fallback.config.timeoutMs, 30_000);

  const mcpJsonFallback = await discoverBoardConfigV1({
    argv: [],
    cwd: fallbackRoot,
    env: {
      BOARD_API_URL: 'https://sceneboard.dev',
      BOARD_ACCESS_TOKEN_REF: 'store://sceneboard',
      BOARD_PROFILE: 'sceneboard',
      BOARD_TIMEOUT_MS: '45000',
    },
  });
  assert.equal(mcpJsonFallback.source, 'environment');
  assert.deepEqual(mcpJsonFallback.config, {
    version: 1,
    baseUrl: 'https://sceneboard.dev',
    accessTokenRef: 'store://sceneboard',
    authScheme: 'bearer',
    timeoutMs: 45_000,
    profile: 'sceneboard',
  });
});

test('nearest repository config rejects a custom origin without falling through', async () => {
  const root = await makeRoot();
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });
  await writeFile(
    join(project, '.board.json'),
    JSON.stringify({ ...validConfig, baseUrl: 'https://attacker.invalid' }),
    { mode: 0o600 },
  );
  await assert.rejects(
    () =>
      discoverBoardConfigV1({
        argv: [],
        cwd: project,
        env: { BOARD_API_URL: 'https://sceneboard.dev' },
      }),
    (error: unknown) =>
      error instanceof BoardConfigError &&
      error.source === 'nearest_board_file' &&
      error.field === 'baseUrl',
  );
});

test('environment fallback rejects mismatched store profiles and malformed timeouts', async () => {
  const root = await makeRoot();
  await assert.rejects(
    () =>
      discoverBoardConfigV1({
        argv: [],
        cwd: root,
        env: {
          BOARD_API_URL: 'https://sceneboard.dev',
          BOARD_ACCESS_TOKEN_REF: 'store://other',
          BOARD_PROFILE: 'sceneboard',
        },
      }),
    BoardConfigError,
  );
  await assert.rejects(
    () =>
      discoverBoardConfigV1({
        argv: [],
        cwd: root,
        env: {
          BOARD_API_URL: 'https://sceneboard.dev',
          BOARD_TIMEOUT_MS: '30s',
        },
      }),
    BoardConfigError,
  );
});

test('selected invalid candidates fail closed without falling through', async () => {
  const root = await makeRoot();
  const invalid = join(root, 'invalid.json');
  await writeFile(invalid, '{"version":2}', { mode: 0o600 });
  await assert.rejects(
    () =>
      discoverBoardConfigV1({
        argv: [`--config=${invalid}`],
        cwd: root,
        env: { BOARD_API_URL: 'https://sceneboard.dev' },
      }),
    (error: unknown) => error instanceof BoardConfigError && error.source === 'process_option',
  );
});

test('config files reject symlinks and group or other writable modes', async () => {
  const root = await makeRoot();
  const target = join(root, 'target.json');
  const link = join(root, 'link.json');
  await writeFile(target, JSON.stringify(validConfig), { mode: 0o600 });
  await symlink(target, link);
  await assert.rejects(
    () => discoverBoardConfigV1({ argv: [`--config=${link}`], cwd: root, env: {} }),
    BoardConfigError,
  );

  await chmod(target, 0o622);
  await assert.rejects(
    () => discoverBoardConfigV1({ argv: [`--config=${target}`], cwd: root, env: {} }),
    BoardConfigError,
  );
});
