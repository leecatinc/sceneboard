import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const buildAndRead = (): { path: string; sha256: string; source: string } => {
  execFileSync('npm', ['run', 'build:runtime'], { cwd: packageRoot, stdio: 'pipe' });
  const manifest = JSON.parse(
    readFileSync(resolve(packageRoot, 'dist/public/fixed-assets.v1.json'), 'utf8'),
  ) as Array<{ logicalName: string; path: string; sha256: string }>;
  const outer = manifest.find((entry) => entry.logicalName === 'outer');
  if (outer === undefined) throw new TypeError('outer runtime asset is missing');
  const bytes = readFileSync(resolve(packageRoot, `dist/public${outer.path}`));
  return {
    path: outer.path,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    source: bytes.toString('utf8'),
  };
};

test('deterministic emitted runner contains trusted navigation and one-shot sizing', () => {
  const first = buildAndRead();
  const second = buildAndRead();
  assert.deepEqual(
    { path: second.path, sha256: second.sha256 },
    { path: first.path, sha256: first.sha256 },
  );
  assert.equal(first.sha256, first.path.match(/outer\.([0-9a-f]{64})\.js$/u)?.[1]);
  assert.match(first.source, /artifact\.navigation\.wheel/u);
  assert.match(first.source, /artifact bridge envelope is invalid/u);
  assert.match(first.source, /artifact host message is invalid/u);
  assert.doesNotMatch(first.source, /ResizeObserver/u);
});
