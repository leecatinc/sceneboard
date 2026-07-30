import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const workspaceManifests = new Map([
  ['@sceneboard/board-schema', 'packages/board-schema/package.json'],
  ['@sceneboard/board-sdk', 'packages/board-sdk/package.json'],
  ['@sceneboard/artifact-runtime', 'packages/artifact-runtime/package.json'],
  ['@sceneboard/board-ui', 'packages/board-ui/package.json'],
  ['sceneboard-mcp', 'sceneboard-mcp/package.json'],
  ['sceneboard-be', 'sceneboard-be/package.json'],
  ['sceneboard-fe', 'sceneboard-fe/package.json'],
]);
const expectedDependencies = new Map([
  ['@sceneboard/board-schema', []],
  ['@sceneboard/board-sdk', ['@sceneboard/board-schema']],
  ['@sceneboard/artifact-runtime', ['@sceneboard/board-schema']],
  ['@sceneboard/board-ui', ['@sceneboard/artifact-runtime', '@sceneboard/board-schema']],
  ['sceneboard-mcp', ['@sceneboard/board-schema', '@sceneboard/board-sdk']],
  ['sceneboard-be', ['@sceneboard/artifact-runtime', '@sceneboard/board-schema']],
  [
    'sceneboard-fe',
    [
      '@sceneboard/artifact-runtime',
      '@sceneboard/board-schema',
      '@sceneboard/board-sdk',
      '@sceneboard/board-ui',
    ],
  ],
]);

const readWorkspaceGraph = async () => {
  const graph = new Map();
  for (const [name, manifestPath] of workspaceManifests) {
    const manifest = JSON.parse(await readFile(path.join(root, manifestPath), 'utf8'));
    assert.equal(manifest.name, name, manifestPath);
    const dependencies = Object.keys({
      ...manifest.dependencies,
      ...manifest.optionalDependencies,
      ...manifest.peerDependencies,
    })
      .filter((dependency) => workspaceManifests.has(dependency))
      .sort();
    graph.set(name, dependencies);
  }
  return graph;
};

const collectSources = async (directory) => {
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) output.push(...(await collectSources(absolute)));
    else if (/\.(?:[cm]?[jt]sx?)$/u.test(entry.name)) output.push(absolute);
  }
  return output;
};

test('workspace dependencies follow the public acyclic package direction', async () => {
  const graph = await readWorkspaceGraph();
  assert.deepEqual(graph, expectedDependencies);

  const active = new Set();
  const visited = new Set();
  const visit = (name) => {
    assert.equal(active.has(name), false, `workspace dependency cycle at ${name}`);
    if (visited.has(name)) return;
    active.add(name);
    for (const dependency of graph.get(name) ?? []) visit(dependency);
    active.delete(name);
    visited.add(name);
  };
  for (const name of graph.keys()) visit(name);
});

test('production sources consume workspace packages only through public package exports', async () => {
  const sourceRoots = [
    'packages/artifact-runtime/src',
    'packages/board-schema/src',
    'packages/board-sdk/src',
    'packages/board-ui/src',
    'sceneboard-be/src',
    'sceneboard-fe/app',
    'sceneboard-fe/components',
    'sceneboard-fe/lib',
    'sceneboard-mcp/src',
  ];
  for (const sourceRoot of sourceRoots) {
    for (const file of await collectSources(path.join(root, sourceRoot))) {
      const source = await readFile(file, 'utf8');
      assert.doesNotMatch(
        source,
        /@sceneboard\/(?:artifact-runtime|board-schema|board-sdk|board-ui)\/(?:src|test)(?:\/|['"])/u,
        path.relative(root, file),
      );
      assert.doesNotMatch(
        source,
        /packages\/(?:artifact-runtime|board-schema|board-sdk|board-ui)\/(?:src|test)\//u,
        path.relative(root, file),
      );
    }
  }
});
