import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createBuildCheckEnvironment, withRestoredFile } from './run-build-check.mjs';

test('build-check environment supplies deterministic non-secret local origins', () => {
  const environment = createBuildCheckEnvironment({ NODE_ENV: 'development', KEEP_ME: 'yes' });

  assert.equal(environment.NODE_ENV, 'production');
  assert.equal(environment.SCENEBOARD_NEXT_DIST_DIR, '.next-check');
  assert.equal(environment.NEXT_PUBLIC_BOARD_API_URL, 'http://127.0.0.1:3411');
  assert.equal(environment.NEXT_PUBLIC_ARTIFACT_RUNTIME_ORIGIN, 'http://127.0.0.2:3412');
  assert.equal(environment.KEEP_ME, 'yes');
});

test('build-check environment preserves explicitly configured public origins', () => {
  const environment = createBuildCheckEnvironment({
    NEXT_PUBLIC_BOARD_API_URL: 'https://api.sceneboard.dev',
    NEXT_PUBLIC_ARTIFACT_RUNTIME_ORIGIN: 'https://artifact.sceneboard.dev',
  });

  assert.equal(environment.NEXT_PUBLIC_BOARD_API_URL, 'https://api.sceneboard.dev');
  assert.equal(environment.NEXT_PUBLIC_ARTIFACT_RUNTIME_ORIGIN, 'https://artifact.sceneboard.dev');
});

test('build-check environment isolates frontend output from the served Next.js build', () => {
  const environment = createBuildCheckEnvironment({
    SCENEBOARD_NEXT_DIST_DIR: '.next-live',
  });

  assert.equal(environment.SCENEBOARD_NEXT_DIST_DIR, '.next-check');
});

test('build-check restores the served Next.js declaration after an isolated build', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sceneboard-build-check-'));
  const declaration = join(directory, 'next-env.d.ts');
  await writeFile(declaration, 'served build\n');

  try {
    const result = withRestoredFile(declaration, () => {
      writeFileSync(declaration, 'check build\n');
      return 17;
    });

    assert.equal(result, 17);
    assert.equal(await readFile(declaration, 'utf8'), 'served build\n');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
