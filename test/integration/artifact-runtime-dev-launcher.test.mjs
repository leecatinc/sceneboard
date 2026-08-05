import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const launcherPath = new URL(
  '../../packages/artifact-runtime/deploy/launch-dev-runtime.sh',
  import.meta.url,
);
const pm2ConfigPath = new URL(
  '../../packages/artifact-runtime/deploy/pm2.dev.config.cjs',
  import.meta.url,
);
const evidenceGeneratorPath = new URL(
  '../../packages/artifact-runtime/deploy/create-dev-origin-evidence.mjs',
  import.meta.url,
);

const runNode = (arguments_) =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, arguments_, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr || `evidence generator exited with ${String(code)}`));
    });
  });

test('the development artifact launcher resolves the monorepo from its own location', async () => {
  const launcher = await readFile(launcherPath, 'utf8');

  assert.match(launcher, /BASH_SOURCE\[0\]/u);
  assert.doesNotMatch(launcher, /ROOT=\/workspace\/lc\/leecat-board/u);
});

test('the PM2 development config derives runtime paths from the checked-in config', async () => {
  const pm2Config = await readFile(pm2ConfigPath, 'utf8');

  assert.match(pm2Config, /__dirname/u);
  assert.doesNotMatch(pm2Config, /['"]\/workspace\/lc\/leecat-board\/(?:packages|monorepo)/u);
});

test('the hosted runtime evidence generator supports production bootstrap inputs', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'sceneboard-runtime-evidence-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const frontendPath = join(directory, 'frontend.json');
  const backendPath = join(directory, 'backend.json');
  const runtimePath = join(directory, 'runtime.json');
  const evidencePath = join(directory, 'evidence.json');
  await Promise.all([
    writeFile(
      frontendPath,
      '{"NEXT_PUBLIC_BOARD_API_URL":"https://sceneboard.dev","NEXT_PUBLIC_ARTIFACT_RUNTIME_ORIGIN":"https://artifact.sceneboard.dev"}\n',
    ),
    writeFile(
      backendPath,
      '{"APP_ENV":"production","BOARD_ALLOWED_ORIGINS":"https://sceneboard.dev","BOARD_PUBLIC_API_ORIGIN":"https://sceneboard.dev"}\n',
    ),
    writeFile(
      runtimePath,
      '{"ARTIFACT_RUNTIME_APP_ORIGIN":"https://sceneboard.dev","ARTIFACT_RUNTIME_API_ORIGIN":"https://sceneboard.dev","ARTIFACT_RUNTIME_ORIGIN":"https://artifact.sceneboard.dev"}\n',
    ),
  ]);

  await runNode([
    evidenceGeneratorPath.pathname,
    frontendPath,
    backendPath,
    runtimePath,
    evidencePath,
  ]);

  const evidence = JSON.parse(await readFile(evidencePath, 'utf8'));
  assert.equal(evidence.schemaVersion, 'auth-artifact-origin-evidence/v2');
  assert.equal(evidence.appEnv, 'production');
  assert.equal(evidence.runtimeOrigin, 'https://artifact.sceneboard.dev');
});
