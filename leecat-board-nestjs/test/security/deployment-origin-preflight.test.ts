import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

const root = new URL('../../../', import.meta.url).pathname;

test('writes non-secret joint origin evidence and rejects a frontend/backend mismatch', async () => {
  const directory = `/workspace/.tmp/agent/auth-origin-${process.pid}`;
  await rm(directory, { force: true, recursive: true });
  await mkdir(directory, { recursive: true });
  const frontend = join(directory, 'frontend.json');
  const backend = join(directory, 'backend.json');
  const runtime = join(directory, 'runtime.json');
  const output = join(directory, 'evidence.json');
  await writeFile(frontend, JSON.stringify({
    NEXT_PUBLIC_BOARD_API_URL: 'https://sceneboard.dev:3411',
    NEXT_PUBLIC_ARTIFACT_RUNTIME_ORIGIN: 'https://runtime.sceneboard.dev',
  }));
  await writeFile(backend, JSON.stringify({
    APP_ENV: 'production',
    BOARD_ALLOWED_ORIGINS: 'https://sceneboard.dev',
    BOARD_PUBLIC_API_ORIGIN: 'https://sceneboard.dev:3411',
  }));
  await writeFile(runtime, JSON.stringify({
    ARTIFACT_RUNTIME_APP_ORIGIN: 'https://sceneboard.dev',
    ARTIFACT_RUNTIME_API_ORIGIN: 'https://sceneboard.dev:3411',
    ARTIFACT_RUNTIME_ORIGIN: 'https://runtime.sceneboard.dev',
  }));

  const success = spawnSync(process.execPath, [
    'scripts/verify-auth-origin-topology.mjs',
    '--frontend-env', frontend,
    '--backend-env', backend,
    '--runtime-env', runtime,
    '--out', output,
  ], { cwd: root, encoding: 'utf8' });
  assert.equal(success.status, 0, success.stderr);
  const evidence = JSON.parse(await readFile(output, 'utf8')) as Record<string, unknown>;
  assert.equal(evidence.frontendOrigin, 'https://sceneboard.dev');
  assert.equal(evidence.apiOrigin, 'https://sceneboard.dev:3411');
  assert.equal(evidence.runtimeOrigin, 'https://runtime.sceneboard.dev');
  assert.match(String(evidence.frontendInputSha256), /^[a-f0-9]{64}$/);
  assert.match(String(evidence.backendInputSha256), /^[a-f0-9]{64}$/);
  assert.match(String(evidence.runtimeInputSha256), /^[a-f0-9]{64}$/);

  await writeFile(frontend, JSON.stringify({
    NEXT_PUBLIC_BOARD_API_URL: 'https://api.sceneboard.dev',
    NEXT_PUBLIC_ARTIFACT_RUNTIME_ORIGIN: 'https://runtime.sceneboard.dev',
  }));
  const mismatch = spawnSync(process.execPath, [
    'scripts/verify-auth-origin-topology.mjs',
    '--frontend-env', frontend,
    '--backend-env', backend,
    '--runtime-env', runtime,
    '--out', output,
  ], { cwd: root, encoding: 'utf8' });
  assert.notEqual(mismatch.status, 0);
  await rm(directory, { force: true, recursive: true });
});
