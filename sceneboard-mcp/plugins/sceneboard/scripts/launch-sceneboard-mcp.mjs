#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { access, chmod, lstat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  configResolutionFailureCodeV1,
  resolveSceneBoardServer,
  sceneBoardLaunchFailureLineV1,
} from './sceneboard-mcp-config.mjs';

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const accountApiKeyPattern = /^sbk_v1\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/u;
const runtimeSafeEnvironmentNames = [
  'APPDATA',
  'COMSPEC',
  'HOME',
  'LANG',
  'LC_ALL',
  'LOCALAPPDATA',
  'PATH',
  'PATHEXT',
  'SYSTEMROOT',
  'SystemRoot',
  'TEMP',
  'TMP',
  'TMPDIR',
  'USERPROFILE',
  'WINDIR',
  'XDG_CONFIG_HOME',
  'XDG_STATE_HOME',
];

const fail = (code) => {
  process.stderr.write(sceneBoardLaunchFailureLineV1(code));
  process.exitCode = 78;
};

const normalizeProductionHelpers = async () => {
  if (process.platform !== 'linux') return;
  const helper = resolve(pluginRoot, 'native/profile-lease-helper');
  const digest = resolve(pluginRoot, 'native/profile-lease-helper.sha256');
  const exportHelper = resolve(pluginRoot, 'native/linux-x64-gnu/local-export-helper');
  const exportDigest = resolve(pluginRoot, 'native/linux-x64-gnu/local-export-helper.sha256');
  const exportManifest = resolve(pluginRoot, 'native/local-export-helper.manifest.json');
  const [helperStatus, digestStatus, exportHelperStatus, exportDigestStatus, manifestStatus] =
    await Promise.all([
      lstat(helper),
      lstat(digest),
      lstat(exportHelper),
      lstat(exportDigest),
      lstat(exportManifest),
    ]);
  if (
    !helperStatus.isFile() ||
    helperStatus.isSymbolicLink() ||
    !digestStatus.isFile() ||
    digestStatus.isSymbolicLink() ||
    !exportHelperStatus.isFile() ||
    exportHelperStatus.isSymbolicLink() ||
    !exportDigestStatus.isFile() ||
    exportDigestStatus.isSymbolicLink() ||
    !manifestStatus.isFile() ||
    manifestStatus.isSymbolicLink()
  ) {
    throw new TypeError('production_native_invalid');
  }
  await Promise.all([
    chmod(helper, 0o500),
    chmod(digest, 0o400),
    chmod(exportHelper, 0o500),
    chmod(exportDigest, 0o400),
    chmod(exportManifest, 0o400),
  ]);
};

const childEnvironment = (selected) => {
  const environment = {};
  for (const name of runtimeSafeEnvironmentNames) {
    const value = process.env[name];
    if (typeof value === 'string' && !accountApiKeyPattern.test(value)) environment[name] = value;
  }
  Object.assign(environment, selected.server.env, { SCENEBOARD_CONFIG_DEPTH: '1' });
  if (
    selected.source === 'production_default' &&
    selected.server.env.BOARD_CREDENTIAL_MODE === 'api_key' &&
    selected.server.env.BOARD_ACCESS_TOKEN_REF === 'env://SCENEBOARD_API_KEY' &&
    typeof process.env.SCENEBOARD_API_KEY === 'string'
  ) {
    environment.SCENEBOARD_API_KEY = process.env.SCENEBOARD_API_KEY;
  }
  return environment;
};

try {
  const selected = await resolveSceneBoardServer({ pluginRoot });
  if (selected.source === 'production_default') {
    try {
      await Promise.all([access(selected.server.args[0]), normalizeProductionHelpers()]);
    } catch {
      fail('production_runtime_unavailable');
      process.exit();
    }
  }

  const child = spawn(selected.server.command, selected.server.args, {
    cwd: selected.server.cwd ?? process.cwd(),
    env: childEnvironment(selected),
    stdio: 'inherit',
  });
  const forward = (signal) => {
    if (!child.killed) child.kill(signal);
  };
  process.once('SIGINT', () => forward('SIGINT'));
  process.once('SIGTERM', () => forward('SIGTERM'));
  child.once('error', () => fail('server_process_start_failed'));
  child.once('exit', (code, signal) => {
    if (signal !== null) process.kill(process.pid, signal);
    else process.exitCode = code ?? 1;
  });
} catch (error) {
  fail(configResolutionFailureCodeV1(error));
}
