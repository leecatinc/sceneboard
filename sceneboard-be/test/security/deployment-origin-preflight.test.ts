import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join, parse, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const verificationScript = join('scripts', 'verify-auth-origin-topology.mjs');

function findWorkspaceRoot(startDirectory: string): string {
  let current = resolve(startDirectory);
  const filesystemRoot = parse(current).root;

  while (current !== filesystemRoot) {
    if (existsSync(join(current, verificationScript))) {
      return current;
    }
    current = dirname(current);
  }

  throw new Error(`Could not locate ${verificationScript} from ${startDirectory}`);
}

const root = findWorkspaceRoot(dirname(fileURLToPath(import.meta.url)));
const { verifyAuthOriginTopology } = await import(
  join(root, 'scripts', 'verify-auth-origin-topology.mjs')
);

test('writes non-secret joint origin evidence and rejects a frontend/backend mismatch', async () => {
  const directory = await mkdtemp(join(root, '.auth-origin-'));
  const frontend = join(directory, 'frontend.json');
  const backend = join(directory, 'backend.json');
  const runtime = join(directory, 'runtime.json');
  const writeCanonical = async (path: string, value: Record<string, string>) => {
    await writeFile(path, `${JSON.stringify(value, Object.keys(value).sort())}\n`, { mode: 0o600 });
    await chmod(path, 0o600);
  };
  await writeCanonical(frontend, {
    NEXT_PUBLIC_BOARD_API_URL: 'https://sceneboard.dev:3411',
    NEXT_PUBLIC_ARTIFACT_RUNTIME_ORIGIN: 'https://runtime.sceneboard.dev',
  });
  await writeCanonical(backend, {
    APP_ENV: 'staging',
    BOARD_ALLOWED_ORIGINS: 'https://sceneboard.dev',
    BOARD_PUBLIC_API_ORIGIN: 'https://sceneboard.dev:3411',
  });
  await writeCanonical(runtime, {
    ARTIFACT_RUNTIME_APP_ORIGIN: 'https://sceneboard.dev',
    ARTIFACT_RUNTIME_API_ORIGIN: 'https://sceneboard.dev:3411',
    ARTIFACT_RUNTIME_ORIGIN: 'https://runtime.sceneboard.dev',
  });

  const identity = {
    sourceCommit: 'a'.repeat(40),
    manifestSha256: 'b'.repeat(64),
    profile: 'non-production',
    environment: 'staging',
    attemptId: 'test-attempt',
  };
  const evidence = (await verifyAuthOriginTopology({
    frontendPath: frontend,
    backendPath: backend,
    runtimePath: runtime,
    identity,
  })) as Record<string, unknown>;
  assert.equal(evidence.frontendOrigin, 'https://sceneboard.dev');
  assert.equal(evidence.apiOrigin, 'https://sceneboard.dev:3411');
  assert.equal(evidence.runtimeOrigin, 'https://runtime.sceneboard.dev');
  assert.match(String(evidence.frontendInputSha256), /^[a-f0-9]{64}$/);
  assert.match(String(evidence.backendInputSha256), /^[a-f0-9]{64}$/);
  assert.match(String(evidence.runtimeInputSha256), /^[a-f0-9]{64}$/);
  assert.equal((evidence.target as { kind: string }).kind, 'submitted-deployment-topology');

  await writeCanonical(frontend, {
    NEXT_PUBLIC_BOARD_API_URL: 'https://api.sceneboard.dev',
    NEXT_PUBLIC_ARTIFACT_RUNTIME_ORIGIN: 'https://runtime.sceneboard.dev',
  });
  await Promise.all([frontend, backend, runtime].map((path) => chmod(path, 0o600)));
  await assert.rejects(() =>
    verifyAuthOriginTopology({
      frontendPath: frontend,
      backendPath: backend,
      runtimePath: runtime,
      identity,
    }),
  );
  await rm(directory, { force: true, recursive: true });
});
