import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { test } from 'node:test';

const sourceRoot = new URL('../src/', import.meta.url);

const collect = async (directory: URL): Promise<URL[]> => {
  const output: URL[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const url = new URL(`${entry.name}${entry.isDirectory() ? '/' : ''}`, directory);
    if (entry.isDirectory()) output.push(...(await collect(url)));
    else if (entry.name.endsWith('.ts')) output.push(url);
  }
  return output;
};

test('keeps the exact thirty-three schema source owners', async () => {
  const files = await collect(sourceRoot);
  assert.equal(files.length, 33);
});

test('prevents reverse shared-package and application imports', async () => {
  const files = await collect(sourceRoot);
  for (const file of files) {
    const source = await readFile(file, 'utf8');
    assert.doesNotMatch(
      source,
      /@leecat-board\/(board-sdk|board-ui|artifact-runtime)/,
      file.pathname,
    );
    assert.doesNotMatch(source, /leecat-board-(nextjs|nestjs|mcp)/, file.pathname);
    if (!file.pathname.endsWith('/parsers.ts') && !file.pathname.endsWith('/index.ts'))
      assert.doesNotMatch(source, /['"]\.\/parsers\.js['"]|['"]\.\/index\.js['"]/, file.pathname);
  }
});

test('keeps the recursive edge and catalog ownership singular', async () => {
  const files = await collect(sourceRoot);
  let lazyCount = 0;
  let nodeCatalogOwners = 0;
  for (const file of files) {
    const source = await readFile(file, 'utf8');
    lazyCount += (source.match(/z\.lazy\(/g) ?? []).length;
    if (/export const NODE_TYPES_V1\s*=/.test(source)) nodeCatalogOwners += 1;
  }
  assert.equal(lazyCount, 1);
  assert.equal(nodeCatalogOwners, 1);
});

test('keeps the runtime value-import graph acyclic', async () => {
  const files = await collect(sourceRoot);
  const byName = new Map(
    files.map((file) => [
      file.pathname.replace(sourceRoot.pathname, '').replace(/\.ts$/, ''),
      file,
    ]),
  );
  const graph = new Map<string, string[]>();
  for (const [name, file] of byName) {
    const source = await readFile(file, 'utf8');
    const imports = [
      ...source.matchAll(/^import(?!\s+type\b)[\s\S]*?from\s+['"](\.\.?\/[^'"]+)\.js['"];?$/gm),
    ]
      .map((match) => match[1])
      .filter((specifier): specifier is string => specifier !== undefined)
      .map((specifier) => {
        const base = name.split('/');
        base.pop();
        for (const part of specifier.split('/')) {
          if (part === '.') continue;
          if (part === '..') base.pop();
          else base.push(part);
        }
        return base.join('/');
      })
      .filter((dependency) => byName.has(dependency));
    graph.set(name, imports);
  }

  const active = new Set<string>();
  const visited = new Set<string>();
  const visit = (name: string): void => {
    if (active.has(name)) assert.fail(`runtime import cycle at ${name}`);
    if (visited.has(name)) return;
    active.add(name);
    for (const dependency of graph.get(name) ?? []) visit(dependency);
    active.delete(name);
    visited.add(name);
  };
  for (const name of graph.keys()) visit(name);
});

test('keeps shared primitive and revision runtime ownership in identifiers', async () => {
  const expectedConsumers = new Map([
    [
      'ShortTextSchemaV1',
      [
        'artifacts',
        'commands',
        'errors',
        'hitl',
        'nodes/base',
        'nodes/content',
        'nodes/drawing',
        'nodes/layout',
        'operations',
        'parsers',
        'public-shares',
        'scene',
        'share-analytics',
      ],
    ],
    ['ContentTextSchemaV1', ['hitl', 'nodes/content']],
    ['LocalFieldIdSchemaV1', ['hitl', 'nodes/content', 'nodes/drawing']],
    ['RevisionSummarySchemaV1', ['commands', 'events', 'operations', 'snapshots']],
    ['RevisionOriginTypeSchemaV1', ['events', 'operations', 'snapshots']],
  ]);
  const files = await collect(sourceRoot);
  for (const [symbol, consumers] of expectedConsumers) {
    const actual: string[] = [];
    for (const file of files) {
      const name = file.pathname.replace(sourceRoot.pathname, '').replace(/\.ts$/, '');
      if (name === 'identifiers') continue;
      const source = await readFile(file, 'utf8');
      if (new RegExp(`\\b${symbol}\\b`).test(source)) actual.push(name);
      assert.equal(
        new RegExp(`(?:const|let|var)\\s+${symbol}\\s*=`).test(source),
        false,
        `${name} duplicates ${symbol}`,
      );
    }
    assert.deepEqual(actual.sort(), consumers.sort(), symbol);
  }
});

test('uses discriminant-indexed dispatch for every exact tagged catalog', async () => {
  const expectations = new Map<string, Array<[string, number]>>([
    ['scene', [["z.discriminatedUnion('type'", 1]]],
    ['nodes/drawing', [["z.discriminatedUnion('type'", 1]]],
    ['nodes/geojson', [["z.discriminatedUnion('type'", 1]]],
    [
      'hitl',
      [
        ["z.discriminatedUnion('type'", 1],
        [".discriminatedUnion('kind'", 2],
      ],
    ],
    ['commands', [["z.discriminatedUnion('type'", 2]]],
    ['operations', [["z.discriminatedUnion('type'", 2]]],
    ['events', [["z.discriminatedUnion('type'", 1]]],
    [
      'errors',
      [
        ["z.discriminatedUnion('code'", 1],
        ["z.discriminatedUnion('scope'", 1],
      ],
    ],
  ]);
  const files = await collect(sourceRoot);
  const sources = new Map(
    await Promise.all(
      files.map(
        async (file) =>
          [
            file.pathname.replace(sourceRoot.pathname, '').replace(/\.ts$/, ''),
            await readFile(file, 'utf8'),
          ] as const,
      ),
    ),
  );
  for (const [file, patterns] of expectations) {
    const source = sources.get(file) ?? '';
    for (const [pattern, minimum] of patterns)
      assert.equal(source.split(pattern).length - 1 >= minimum, true, `${file}: ${pattern}`);
  }
});
