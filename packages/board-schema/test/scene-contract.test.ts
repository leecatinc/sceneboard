import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  BOARD_LIMITS_V1,
  BoardEventEnvelopeParserV1,
  BoardNodeParserV1,
  BoardOperationResultParserV1,
  BoardSnapshotParserV1,
  MutationRequestParserV1,
  NODE_TYPES_V1,
  SceneParserV1,
  canonicalizeJsonV1,
} from '../src/index.js';
import { loadFixture } from './helpers/load-fixture.js';

const markdownNode = (id: string) => ({ id, type: 'content.markdown', markdown: 'ok' });

const nestedScene = (depth: number) => {
  let root: unknown = markdownNode(`node${depth}`);
  for (let level = depth - 1; level >= 1; level -= 1) {
    root = { id: `node${level}`, type: 'layout.tabs', activeTabId: `tab${level}`, tabs: [{ tabId: `tab${level}`, label: `Tab ${level}`, node: root }] };
  }
  return { protocolVersion: 1, type: 'scene', root };
};

const sceneWithCanonicalBytes = (target: number) => {
  const root = {
    id: 'root',
    type: 'layout.split',
    direction: 'horizontal',
    gap: 0,
    children: Array.from({ length: 5 }, (_, index) => ({
      node: { id: `code${index}`, type: 'content.code', language: 'txt', code: 'a'.repeat(150_000), showLineNumbers: false, wrap: false },
      weight: 1,
    })),
  };
  const scene = { protocolVersion: 1, type: 'scene', root };
  const initial = canonicalizeJsonV1(scene);
  assert.equal(initial.ok, true);
  if (!initial.ok) return scene;
  const delta = target - initial.data.canonicalBytes.byteLength;
  assert.equal(delta > 0, true);
  root.children[4]!.node.code += 'a'.repeat(delta);
  const adjusted = canonicalizeJsonV1(scene);
  assert.equal(adjusted.ok, true);
  if (adjusted.ok) assert.equal(adjusted.data.canonicalBytes.byteLength, target);
  return scene;
};

test('accepts the exact fifteen-node recursive catalog', async () => {
  assert.equal(NODE_TYPES_V1.length, 15);
  assert.equal(new Set(NODE_TYPES_V1).size, 15);
  const result = SceneParserV1.parse(await loadFixture('valid/scene-all-node-types.v1.json'));
  assert.equal(result.ok, true);
});

test('rejects unknown types after earlier scene limits', () => {
  const unknown = { protocolVersion: 1, type: 'scene', root: { id: 'root', type: 'content.unknown' } };
  const result = SceneParserV1.parse(unknown);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, 'UNKNOWN_NODE_TYPE');
});

test('enforces duplicate IDs and layout correlations', async () => {
  for (const path of ['invalid/scene-duplicate-node-id.v1.json', 'invalid/scene-grid-overlap.v1.json', 'invalid/scene-tabs-missing-active.v1.json']) {
    const result = SceneParserV1.parse(await loadFixture(path));
    assert.equal(result.ok, false, path);
  }
});

test('guards standalone nodes with the recursive scene policy', async () => {
  const result = BoardNodeParserV1.parse(await loadFixture('valid/board-node-markdown.v1.json'));
  assert.equal(result.ok, true);
  const extra = BoardNodeParserV1.parse({ id: 'node', type: 'content.markdown', markdown: 'ok', unsafe: true });
  assert.equal(extra.ok, false);
});

test('uses one discriminant-indexed node dispatch and one lazy recursion edge', async () => {
  const source = await import('node:fs/promises').then(({ readFile }) => readFile(new URL('../src/scene.ts', import.meta.url), 'utf8'));
  assert.equal((source.match(/z\.lazy\(/g) ?? []).length, 1);
  assert.match(source, /z\.discriminatedUnion\('type'/);
  assert.doesNotMatch(source, /z\.union\(\[\s*layouts\./);
});

test('keeps split cardinality reachable and rejects one over with the advertised limit', () => {
  const makeScene = (count: number) => ({
    protocolVersion: 1,
    type: 'scene',
    root: {
      id: 'root', type: 'layout.split', direction: 'horizontal', gap: 0,
      children: Array.from({ length: count }, (_, index) => ({ node: { id: `node${index}`, type: 'content.markdown', markdown: 'ok' }, weight: 1 })),
    },
  });
  assert.equal(SceneParserV1.parse(makeScene(12)).ok, true);
  const over = SceneParserV1.parse(makeScene(13));
  assert.equal(over.ok, false);
  if (!over.ok) assert.equal(over.error.code, 'LIMIT_EXCEEDED');
});

test('selects scene bytes and typed row limits before an unknown sibling type', () => {
  const unknown = { id: 'unknown', type: 'content.unknown' };
  const table = {
    id: 'table', type: 'content.table', columns: [{ key: 'value', label: 'Value', valueType: 'string' }],
    rows: Array.from({ length: 501 }, (_, index) => ({ id: `row${index}`, cells: { value: 'ok' } })),
  };
  const rowFault = SceneParserV1.parse({ protocolVersion: 1, type: 'scene', root: { id: 'root', type: 'layout.split', direction: 'horizontal', gap: 0, children: [{ node: unknown, weight: 1 }, { node: table, weight: 1 }] } });
  assert.equal(rowFault.ok, false);
  if (!rowFault.ok) assert.equal(rowFault.error.code, 'LIMIT_EXCEEDED');

  const largeChildren = Array.from({ length: 4 }, (_, index) => ({ node: { id: `code${index}`, type: 'content.code', language: 'txt', code: 'a'.repeat(200_000), showLineNumbers: false, wrap: false }, weight: 1 }));
  const byteFault = SceneParserV1.parse({ protocolVersion: 1, type: 'scene', root: { id: 'large', type: 'layout.split', direction: 'horizontal', gap: 0, children: [{ node: unknown, weight: 1 }, ...largeChildren] } });
  assert.equal(byteFault.ok, false);
  if (!byteFault.ok) assert.equal(byteFault.error.code, 'PAYLOAD_TOO_LARGE');
});

test('keeps maximum scene depth reachable through every required scene-bearing carrier', async () => {
  const atLimit = nestedScene(BOARD_LIMITS_V1.maxSceneDepth);
  const overLimit = nestedScene(BOARD_LIMITS_V1.maxSceneDepth + 1);
  const snapshot = await loadFixture('valid/snapshot-board.v1.json') as Record<string, unknown>;
  const operation = await loadFixture('valid/operation-result-board-get.v1.json') as Record<string, unknown>;
  const event = await loadFixture('valid/event-board-snapshot.v1.json') as Record<string, unknown>;
  const mutation = await loadFixture('valid/mutation-request-scene-replace.v1.json') as Record<string, unknown>;

  const carriers = [
    [SceneParserV1, atLimit, overLimit],
    [MutationRequestParserV1, { ...mutation, command: { type: 'scene.replace', scene: atLimit } }, { ...mutation, command: { type: 'scene.replace', scene: overLimit } }],
    [BoardSnapshotParserV1, { ...snapshot, scene: atLimit }, { ...snapshot, scene: overLimit }],
    [BoardOperationResultParserV1, { ...operation, result: { ...(operation.result as object), snapshot: { ...((operation.result as Record<string, unknown>).snapshot as object), scene: atLimit } } }, { ...operation, result: { ...(operation.result as object), snapshot: { ...((operation.result as Record<string, unknown>).snapshot as object), scene: overLimit } } }],
    [BoardEventEnvelopeParserV1, { ...event, data: { ...(event.data as object), snapshot: { ...((event.data as Record<string, unknown>).snapshot as object), scene: atLimit } } }, { ...event, data: { ...(event.data as object), snapshot: { ...((event.data as Record<string, unknown>).snapshot as object), scene: overLimit } } }],
  ] as const;

  for (const [parser, valid, invalid] of carriers) {
    assert.equal(parser.parse(valid).ok, true);
    const result = parser.parse(invalid);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, 'LIMIT_EXCEEDED');
  }
});

test('keeps the canonical scene byte ceiling reachable through required wrappers', async () => {
  const atLimit = sceneWithCanonicalBytes(BOARD_LIMITS_V1.maxSceneBytes);
  const overLimit = structuredClone(atLimit);
  const lastCode = (((overLimit.root as Record<string, unknown>).children as Array<{ node: { code: string } }>).at(-1)?.node);
  assert.ok(lastCode);
  lastCode.code += 'a';

  const snapshot = await loadFixture('valid/snapshot-board.v1.json') as Record<string, unknown>;
  const operation = await loadFixture('valid/operation-result-board-get.v1.json') as Record<string, unknown>;
  const event = await loadFixture('valid/event-board-snapshot.v1.json') as Record<string, unknown>;
  const mutation = await loadFixture('valid/mutation-request-scene-replace.v1.json') as Record<string, unknown>;
  const carriers = [
    [SceneParserV1, atLimit, overLimit],
    [MutationRequestParserV1, { ...mutation, command: { type: 'scene.replace', scene: atLimit } }, { ...mutation, command: { type: 'scene.replace', scene: overLimit } }],
    [BoardSnapshotParserV1, { ...snapshot, scene: atLimit }, { ...snapshot, scene: overLimit }],
    [BoardOperationResultParserV1, { ...operation, result: { ...(operation.result as object), snapshot: { ...((operation.result as Record<string, unknown>).snapshot as object), scene: atLimit } } }, { ...operation, result: { ...(operation.result as object), snapshot: { ...((operation.result as Record<string, unknown>).snapshot as object), scene: overLimit } } }],
    [BoardEventEnvelopeParserV1, { ...event, data: { ...(event.data as object), snapshot: { ...((event.data as Record<string, unknown>).snapshot as object), scene: atLimit } } }, { ...event, data: { ...(event.data as object), snapshot: { ...((event.data as Record<string, unknown>).snapshot as object), scene: overLimit } } }],
  ] as const;
  for (const [parser, valid, invalid] of carriers) {
    assert.equal(parser.parse(valid).ok, true);
    const result = parser.parse(invalid);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, 'PAYLOAD_TOO_LARGE');
      assert.deepEqual(result.error.details, { scope: 'scene', actualBytes: BOARD_LIMITS_V1.maxSceneBytes + 1, maximumBytes: BOARD_LIMITS_V1.maxSceneBytes });
    }
  }
});

test('enforces every aggregate scene collection at its advertised boundary', async (context) => {
  const cases = [
    {
      name: 'grid items',
      limit: 'maxGridItems',
      make: (count: number) => ({ id: 'root', type: 'layout.grid', columns: 24, rows: 100, gap: 0, children: Array.from({ length: count }, (_, index) => ({ node: markdownNode(`node${index}`), column: index % 24 + 1, row: Math.floor(index / 24) + 1, columnSpan: 1, rowSpan: 1 })) }),
      maximum: BOARD_LIMITS_V1.maxGridItems,
    },
    {
      name: 'tabs',
      limit: 'maxTabs',
      make: (count: number) => ({ id: 'root', type: 'layout.tabs', activeTabId: 'tab0', tabs: Array.from({ length: count }, (_, index) => ({ tabId: `tab${index}`, label: `Tab ${index}`, node: markdownNode(`node${index}`) })) }),
      maximum: BOARD_LIMITS_V1.maxTabs,
    },
    {
      name: 'canvas items',
      limit: 'maxCanvasItems',
      make: (count: number) => ({ id: 'root', type: 'layout.canvas', width: 1000, height: 1000, children: Array.from({ length: count }, (_, index) => ({ node: markdownNode(`node${index}`), x: index % 100, y: Math.floor(index / 100), width: 1, height: 1, zIndex: index })) }),
      maximum: BOARD_LIMITS_V1.maxCanvasItems,
    },
    {
      name: 'table columns',
      limit: 'maxTableColumns',
      make: (count: number) => ({ id: 'root', type: 'content.table', columns: Array.from({ length: count }, (_, index) => ({ key: `column${index}`, label: `Column ${index}`, valueType: 'string' })), rows: [{ id: 'row0', cells: Object.fromEntries(Array.from({ length: count }, (_, index) => [`column${index}`, 'ok'])) }] }),
      maximum: BOARD_LIMITS_V1.maxTableColumns,
    },
    {
      name: 'table rows',
      limit: 'maxTableRows',
      make: (count: number) => ({ id: 'root', type: 'content.table', columns: [{ key: 'value', label: 'Value', valueType: 'string' }], rows: Array.from({ length: count }, (_, index) => ({ id: `row${index}`, cells: { value: 'ok' } })) }),
      maximum: BOARD_LIMITS_V1.maxTableRows,
    },
    {
      name: 'chart series',
      limit: 'maxChartSeries',
      make: (count: number) => ({ id: 'root', type: 'content.chart', chartType: 'line', xAxis: { valueType: 'number' }, yAxis: {}, series: Array.from({ length: count }, (_, index) => ({ id: `series${index}`, label: `Series ${index}`, points: [{ x: 0, y: 0 }] })) }),
      maximum: BOARD_LIMITS_V1.maxChartSeries,
    },
    {
      name: 'map features',
      limit: 'maxMapFeatures',
      make: (count: number) => ({ id: 'root', type: 'content.map', viewport: { longitude: 0, latitude: 0, zoom: 1 }, data: { type: 'FeatureCollection', features: Array.from({ length: count }, (_, index) => ({ type: 'Feature', id: index, properties: {}, geometry: { type: 'Point', coordinates: [0, 0] } })) } }),
      maximum: BOARD_LIMITS_V1.maxMapFeatures,
    },
    {
      name: 'drawing elements',
      limit: 'maxDrawingElements',
      make: (count: number) => ({ id: 'root', type: 'content.drawing', viewBox: { x: 0, y: 0, width: 100, height: 100 }, elements: Array.from({ length: count }, (_, index) => ({ id: `element${index}`, type: 'rect', x: 0, y: 0, width: 1, height: 1, style: {} })) }),
      maximum: BOARD_LIMITS_V1.maxDrawingElements,
    },
  ] as const;

  for (const item of cases) {
    await context.test(item.name, () => {
      assert.equal(SceneParserV1.parse({ protocolVersion: 1, type: 'scene', root: item.make(item.maximum) }).ok, true);
      const result = SceneParserV1.parse({ protocolVersion: 1, type: 'scene', root: item.make(item.maximum + 1) });
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.error.code, 'LIMIT_EXCEEDED');
        assert.equal(result.error.details !== null && 'limit' in result.error.details ? result.error.details.limit : null, item.limit);
      }
    });
  }
});

test('proves Unicode scalar counting for BMP, astral, and combining text', () => {
  for (const character of ['a', '𐀀', 'é']) {
    const scalarWidth = Array.from(character).length;
    const atLimit = character.repeat(Math.floor(BOARD_LIMITS_V1.maxMarkdownChars / scalarWidth));
    const accepted = SceneParserV1.parse({ protocolVersion: 1, type: 'scene', root: { id: 'root', type: 'content.markdown', markdown: atLimit } });
    assert.equal(accepted.ok, true);
    const over = SceneParserV1.parse({ protocolVersion: 1, type: 'scene', root: { id: 'root', type: 'content.markdown', markdown: `${atLimit}${character}` } });
    assert.equal(over.ok, false);
    if (!over.ok) assert.equal(over.error.code, 'LIMIT_EXCEEDED');
  }
});

test('returns earlier byte and domain limits before unknown node dispatch in standalone and wrapped scenes', async () => {
  const byteScene = sceneWithCanonicalBytes(BOARD_LIMITS_V1.maxSceneBytes);
  ((byteScene.root as Record<string, unknown>).children as unknown[]).push({ node: { id: 'unknown', type: 'content.unknown' }, weight: 1 });
  const mutation = await loadFixture('valid/mutation-request-scene-replace.v1.json') as Record<string, unknown>;
  for (const [parser, input] of [
    [SceneParserV1, byteScene],
    [MutationRequestParserV1, { ...mutation, command: { type: 'scene.replace', scene: byteScene } }],
  ] as const) {
    const result = parser.parse(input);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, 'PAYLOAD_TOO_LARGE');
  }

  const table = { id: 'table', type: 'content.table', columns: [{ key: 'value', label: 'Value', valueType: 'string' }], rows: Array.from({ length: 501 }, (_, index) => ({ id: `row${index}`, cells: { value: 'ok' } })) };
  const domainScene = { protocolVersion: 1, type: 'scene', root: { id: 'root', type: 'layout.split', direction: 'horizontal', gap: 0, children: [{ node: { id: 'unknown', type: 'content.unknown' }, weight: 1 }, { node: table, weight: 1 }] } };
  const standalone = SceneParserV1.parse(domainScene);
  assert.equal(standalone.ok, false);
  if (!standalone.ok) assert.deepEqual(standalone.error.details, { limit: 'maxTableRows', actual: 501, maximum: 500, path: ['root', 'children', 1, 'node', 'rows'] });
  const wrapped = MutationRequestParserV1.parse({ ...mutation, command: { type: 'scene.replace', scene: domainScene } });
  assert.equal(wrapped.ok, false);
  if (!wrapped.ok) assert.deepEqual(wrapped.error.details, { limit: 'maxTableRows', actual: 501, maximum: 500, path: ['command', 'scene', 'root', 'children', 1, 'node', 'rows'] });
});

test('keeps remaining numeric, text, and cumulative scene limits reachable', async (context) => {
  const expectBoundary = async (
    name: string,
    limit: string,
    validRoot: unknown,
    invalidRoot: unknown,
  ): Promise<void> => context.test(name, () => {
    assert.equal(SceneParserV1.parse({ protocolVersion: 1, type: 'scene', root: validRoot }).ok, true);
    const result = SceneParserV1.parse({ protocolVersion: 1, type: 'scene', root: invalidRoot });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.details !== null && 'limit' in result.error.details ? result.error.details.limit : null, limit);
  });

  await expectBoundary(
    'grid columns',
    'maxGridColumns',
    { id: 'root', type: 'layout.grid', columns: 24, rows: 1, gap: 0, children: [{ node: markdownNode('child'), column: 1, row: 1, columnSpan: 1, rowSpan: 1 }] },
    { id: 'root', type: 'layout.grid', columns: 25, rows: 1, gap: 0, children: [{ node: markdownNode('child'), column: 1, row: 1, columnSpan: 1, rowSpan: 1 }] },
  );
  await expectBoundary(
    'grid rows',
    'maxGridRows',
    { id: 'root', type: 'layout.grid', columns: 1, rows: 100, gap: 0, children: [{ node: markdownNode('child'), column: 1, row: 1, columnSpan: 1, rowSpan: 1 }] },
    { id: 'root', type: 'layout.grid', columns: 1, rows: 101, gap: 0, children: [{ node: markdownNode('child'), column: 1, row: 1, columnSpan: 1, rowSpan: 1 }] },
  );
  await expectBoundary(
    'canvas extent',
    'maxCanvasExtent',
    { id: 'root', type: 'layout.canvas', width: 100_000, height: 100_000, children: [{ node: markdownNode('child'), x: 0, y: 0, width: 1, height: 1, zIndex: 0 }] },
    { id: 'root', type: 'layout.canvas', width: 100_001, height: 100_000, children: [{ node: markdownNode('child'), x: 0, y: 0, width: 1, height: 1, zIndex: 0 }] },
  );
  await expectBoundary(
    'title scalars',
    'maxTitleChars',
    { id: 'root', title: '𐀀'.repeat(200), type: 'content.markdown', markdown: 'ok' },
    { id: 'root', title: '𐀀'.repeat(201), type: 'content.markdown', markdown: 'ok' },
  );
  const imageBase = { id: 'root', type: 'content.image', source: { type: 'artifact.resource', artifact: { artifactId: 'artifact_1', versionId: 'version_1' }, path: 'image.png', sha256: 'a'.repeat(64) }, fit: 'contain' };
  await expectBoundary(
    'image alt scalars',
    'maxImageAltChars',
    { ...imageBase, alt: '𐀀'.repeat(500) },
    { ...imageBase, alt: '𐀀'.repeat(501) },
  );
  const codeBase = { id: 'root', type: 'content.code', language: 'txt', showLineNumbers: false, wrap: false };
  await expectBoundary(
    'code scalars',
    'maxCodeChars',
    { ...codeBase, code: 'a'.repeat(200_000) },
    { ...codeBase, code: 'a'.repeat(200_001) },
  );

  const columns = Array.from({ length: 50 }, (_, index) => ({ key: `column${index}`, label: `Column ${index}`, valueType: 'string' }));
  const cells = Object.fromEntries(columns.map((column) => [column.key, 'ok']));
  const table = (rowCount: number) => ({ id: 'root', type: 'content.table', columns, rows: Array.from({ length: rowCount }, (_, index) => ({ id: `row${index}`, cells })) });
  await expectBoundary('table cells', 'maxTableCells', table(200), table(201));
  const tableOver = SceneParserV1.parse({ protocolVersion: 1, type: 'scene', root: table(201) });
  assert.equal(tableOver.ok, false);
  if (!tableOver.ok) assert.deepEqual(tableOver.error.details, { limit: 'maxTableCells', actual: 10_050, maximum: 10_000, path: ['root', 'rows'] });

  const chart = (secondSeriesCount: number) => ({ id: 'root', type: 'content.chart', chartType: 'line', xAxis: { valueType: 'number' }, yAxis: {}, series: [
    { id: 'series0', label: 'Series 0', points: Array.from({ length: 5_000 }, (_, index) => ({ x: index, y: index })) },
    { id: 'series1', label: 'Series 1', points: Array.from({ length: secondSeriesCount }, (_, index) => ({ x: index, y: index })) },
  ] });
  await expectBoundary('cumulative chart points', 'maxChartPoints', chart(5_000), chart(5_001));
});
