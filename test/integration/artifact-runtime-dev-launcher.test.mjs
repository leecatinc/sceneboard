import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const launcherPath = new URL(
  '../../packages/artifact-runtime/deploy/launch-dev-runtime.sh',
  import.meta.url,
);
const pm2ConfigPath = new URL(
  '../../packages/artifact-runtime/deploy/pm2.dev.config.cjs',
  import.meta.url,
);

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
