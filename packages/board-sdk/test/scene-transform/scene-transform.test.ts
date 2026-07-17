import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  SceneParserV1,
  type BoardNodeV1,
  type SceneV1,
} from '@leecat-board/board-schema';

import {
  applySceneTransformV1,
  type SceneTransformOperationV1,
} from '../../src/scene-transform/index.js';

const markdown = (id: string, value: string): BoardNodeV1 => ({
  id: id as never,
  type: 'content.markdown',
  markdown: value,
});

const scene = (): SceneV1 => {
  const candidate = {
    protocolVersion: 1,
    type: 'scene',
    root: {
      id: 'split',
      type: 'layout.split',
      direction: 'horizontal',
      gap: 8,
      children: [
        {
          weight: 1,
          node: {
            id: 'grid',
            type: 'layout.grid',
            columns: 2,
            rows: 2,
            gap: 4,
            children: [
              { node: markdown('m1', 'one'), column: 1, row: 1, columnSpan: 1, rowSpan: 1 },
              { node: markdown('m2', 'two'), column: 2, row: 1, columnSpan: 1, rowSpan: 1 },
            ],
          },
        },
        {
          weight: 1,
          node: {
            id: 'canvas',
            type: 'layout.canvas',
            width: 500,
            height: 400,
            children: [
              {
                node: {
                  id: 'drawing',
                  type: 'content.drawing',
                  viewBox: { x: 0, y: 0, width: 100, height: 100 },
                  elements: [{
                    id: 'old_element',
                    type: 'line',
                    from: { x: 0, y: 0 },
                    to: { x: 10, y: 10 },
                    style: { stroke: '#000000' },
                  }],
                },
                x: 0,
                y: 0,
                width: 100,
                height: 100,
                zIndex: 0,
              },
              {
                node: {
                  id: 'tabs',
                  type: 'layout.tabs',
                  activeTabId: 'tab_a',
                  tabs: [
                    { tabId: 'tab_a', label: 'A', node: markdown('tab_node_a', 'A') },
                    { tabId: 'tab_b', label: 'B', node: markdown('tab_node_b', 'B') },
                  ],
                },
                x: 120,
                y: 0,
                width: 200,
                height: 160,
                zIndex: 1,
              },
            ],
          },
        },
      ],
    },
  };
  const parsed = SceneParserV1.parse(candidate);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) throw new Error('invalid scene fixture');
  return parsed.data.value;
};

test('applies the ordered eleven-operation catalog without mutating the caller scene', () => {
  const source = scene();
  const before = structuredClone(source);
  const operations = [
    { type: 'replace_node', nodeId: 'm1', node: markdown('m1', 'updated') },
    {
      type: 'insert_child',
      parentNodeId: 'grid',
      index: 2,
      node: markdown('m3', 'three'),
      placement: { parentType: 'layout.grid', column: 1, row: 2, columnSpan: 1, rowSpan: 1 },
    },
    {
      type: 'set_grid_placement',
      gridNodeId: 'grid',
      childNodeId: 'm2',
      column: 2,
      row: 2,
      columnSpan: 1,
      rowSpan: 1,
    },
    {
      type: 'move_child',
      sourceParentNodeId: 'grid',
      destinationParentNodeId: 'canvas',
      nodeId: 'm3',
      destinationIndex: 2,
      placement: { parentType: 'layout.canvas', x: 20, y: 200, width: 120, height: 60, zIndex: 2 },
    },
    { type: 'set_split_weight', splitNodeId: 'split', childNodeId: 'canvas', weight: 2 },
    {
      type: 'set_canvas_rect',
      canvasNodeId: 'canvas',
      childNodeId: 'm3',
      x: 40,
      y: 210,
      width: 130,
      height: 70,
      zIndex: 3,
    },
    { type: 'set_active_tab', tabsNodeId: 'tabs', tabId: 'tab_b' },
    {
      type: 'upsert_drawing_element',
      drawingNodeId: 'drawing',
      element: {
        id: 'new_element',
        type: 'rect',
        x: 5,
        y: 5,
        width: 20,
        height: 10,
        style: { fill: '#ffffff' },
      },
    },
    { type: 'remove_drawing_element', drawingNodeId: 'drawing', elementId: 'old_element' },
    { type: 'remove_node', nodeId: 'm2' },
    { type: 'replace_root', root: markdown('new_root', 'complete') },
  ] as unknown as SceneTransformOperationV1[];
  const result = applySceneTransformV1(source, operations);
  assert.equal(result.ok, true);
  if (!result.ok) assert.fail('expected transform success');
  assert.deepEqual(source, before);
  assert.deepEqual(result.data.value.root, markdown('new_root', 'complete'));
  assert.ok(result.data.canonicalBytes.byteLength > 0);
});

test('rejects root misuse, parent-kind mismatch, overlap, and unknown fields atomically', () => {
  const cases: Array<{ operation: unknown; code: string }> = [
    { operation: { type: 'remove_node', nodeId: 'split' }, code: 'INVALID_LAYOUT' },
    {
      operation: {
        type: 'insert_child',
        parentNodeId: 'grid',
        index: 0,
        node: markdown('new_node', 'new'),
        placement: { parentType: 'layout.canvas', x: 0, y: 0, width: 10, height: 10, zIndex: 0 },
      },
      code: 'INVALID_LAYOUT',
    },
    {
      operation: {
        type: 'set_grid_placement',
        gridNodeId: 'grid',
        childNodeId: 'm2',
        column: 1,
        row: 1,
        columnSpan: 1,
        rowSpan: 1,
      },
      code: 'INVALID_LAYOUT',
    },
    { operation: { type: 'remove_node', nodeId: 'm2', extra: true }, code: 'INVALID_PAYLOAD' },
  ];
  for (const value of cases) {
    const source = scene();
    const before = structuredClone(source);
    const result = applySceneTransformV1(source, [value.operation] as never);
    assert.equal(result.ok, false);
    if (result.ok) assert.fail('expected transform failure');
    assert.equal(result.error.code, value.code);
    assert.deepEqual(source, before);
  }
});

test('rejects empty and over-limit operation batches before producing a scene', () => {
  const source = scene();
  const empty = applySceneTransformV1(source, []);
  assert.equal(empty.ok, false);
  if (!empty.ok) assert.equal(empty.error.code, 'INVALID_PAYLOAD');

  const operation = { type: 'set_active_tab', tabsNodeId: 'tabs', tabId: 'tab_a' } as const;
  const oversized = applySceneTransformV1(
    source,
    Array.from({ length: 10_001 }, () => operation) as unknown as SceneTransformOperationV1[],
  );
  assert.equal(oversized.ok, false);
  if (!oversized.ok) assert.equal(oversized.error.code, 'LIMIT_EXCEEDED');
});
