#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveSceneBoardServer } from './sceneboard-mcp-config.mjs';

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const fail = (code) => {
  process.stderr.write(`${JSON.stringify({ event: 'sceneboard_mcp_launch_failed', code, setupUrl: 'https://sceneboard.dev/integrations/codex' })}\n`);
  process.exitCode = 78;
};

try {
  const selected = await resolveSceneBoardServer({ pluginRoot });
  if (selected.source === 'production_default') {
    try {
      await access(selected.server.args[0]);
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
  const forward = (signal) => { if (!child.killed) child.kill(signal); };
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
