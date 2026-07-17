import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { NODE_TYPES_V1, BoardSnapshotParserV1, type BoardSnapshotV1, type ChartNodeV1 } from '@leecat-board/board-schema';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  BoardRenderer,
  RENDERER_REGISTRY_V1,
  buildChartGeometryV1,
  tokenizeSafeMarkdownV1,
} from '../src/renderer/index.js';

const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(`../../board-schema/test/fixtures/valid/${name}`, import.meta.url), 'utf8')) as unknown;

test('trusted renderer registry is byte-for-byte exhaustive over all 15 D1 node types', () => {
  assert.deepEqual(Object.keys(RENDERER_REGISTRY_V1), [...NODE_TYPES_V1]);
  assert.equal(Object.keys(RENDERER_REGISTRY_V1).length, 15);
});

test('all-family scene renders through code-owned elements with inactive D7 and D8 seams', () => {
  const base = fixture('snapshot-board.v1.json') as Record<string, unknown>;
  const snapshotInput = {
    ...base,
    scene: fixture('scene-all-node-types.v1.json'),
    hitl: [fixture('hitl-interaction-open.v1.json')],
    artifacts: [fixture('artifact-runtime-summary-ready.v1.json')],
  };
  const parsed = BoardSnapshotParserV1.parse(snapshotInput);
  assert.equal(parsed.ok, true);
  const html = renderToStaticMarkup(<BoardRenderer snapshot={(parsed as { ok: true; data: { value: BoardSnapshotV1 } }).data.value} />);
  assert.match(html, /Readable canvas contents/);
  assert.match(html, /execution disabled/);
  assert.match(html, /Response unavailable/);
  assert.doesNotMatch(html, /<iframe|<img|srcdoc|javascript:/i);
});

test('safe markdown preserves raw HTML as text and chart projection preserves category order', () => {
  const tokens = tokenizeSafeMarkdownV1('# Title\n<script>alert(1)</script>\n- item\n```ts\nconst x = 1\n```');
  assert.equal(tokens.some((token) => 'text' in token && token.text.includes('<script>')), true);
  const chart: ChartNodeV1 = {
    id: 'chart',
    type: 'content.chart',
    chartType: 'line',
    xAxis: { valueType: 'category' },
    yAxis: {},
    series: [{ id: 'series', label: 'Series', points: [{ x: 'B', y: 1 }, { x: 'A', y: 2 }, { x: 'B', y: 3 }] }],
  } as ChartNodeV1;
  const geometry = buildChartGeometryV1(chart);
  assert.deepEqual(geometry.categoryDomain, ['B', 'A']);
  assert.equal(geometry.tableOnly, false);
});
