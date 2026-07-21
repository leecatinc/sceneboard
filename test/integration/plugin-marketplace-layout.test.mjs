import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

const repositoryRoot = resolve(import.meta.dirname, '../..');
const marketplacePath = resolve(repositoryRoot, '.agents/plugins/marketplace.json');
const packagePaths = [
  'package.json',
  'sceneboard-mcp/package.json',
  'sceneboard-be/package.json',
  'sceneboard-fe/package.json',
  'packages/artifact-runtime/package.json',
  'packages/board-schema/package.json',
  'packages/board-sdk/package.json',
  'packages/board-ui/package.json',
];

test('the public monorepo root exposes the SceneBoard Codex marketplace', () => {
  assert.equal(existsSync(marketplacePath), true);
  const marketplace = JSON.parse(readFileSync(marketplacePath, 'utf8'));
  assert.equal(marketplace.name, 'sceneboard');
  assert.equal(marketplace.plugins.length, 1);
  assert.equal(marketplace.plugins[0].name, 'sceneboard');
  assert.equal(marketplace.plugins[0].source.source, 'local');
  assert.equal(marketplace.plugins[0].source.path, './sceneboard-mcp/plugins/sceneboard');
  assert.equal(existsSync(resolve(repositoryRoot, marketplace.plugins[0].source.path)), true);
});

test('public repository and package metadata identify the official monorepo', () => {
  const readme = readFileSync(resolve(repositoryRoot, 'README.md'), 'utf8');
  assert.match(readme, /# SceneBoard/u);
  assert.match(readme, /leecatinc\/sceneboard/u);
  assert.match(readme, /Apache-2\.0/u);
  for (const packagePath of packagePaths) {
    const manifest = JSON.parse(readFileSync(resolve(repositoryRoot, packagePath), 'utf8'));
    assert.equal(manifest.license, 'Apache-2.0', packagePath);
    assert.equal(manifest.author, 'LeeCat', packagePath);
    assert.equal(
      manifest.repository?.url,
      'git+https://github.com/leecatinc/sceneboard.git',
      packagePath,
    );
    assert.equal(manifest.homepage, 'https://sceneboard.dev', packagePath);
    assert.equal(manifest.bugs?.url, 'https://github.com/leecatinc/sceneboard/issues', packagePath);
  }
});
