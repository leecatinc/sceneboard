#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { access, chmod, lstat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveSceneBoardServer } from './sceneboard-mcp-config.mjs';

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const fail = (code) => {
  process.stderr.write(
    `${JSON.stringify({ event: 'sceneboard_mcp_launch_failed', code, setupUrl: 'https://sceneboard.dev/integrations/codex' })}\n`,
  );
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
    env: {
      ...process.env,
      ...selected.server.env,
      SCENEBOARD_CONFIG_DEPTH: '1',
    },
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
  fail(error instanceof Error ? error.message : 'config_resolution_failed');
}
