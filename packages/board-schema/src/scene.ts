import { z } from 'zod';

import type { ArtifactReferenceV1 } from './artifacts.js';
import type { HitlRequestId, LocalFieldId, NodeId, ShortText, TabId } from './identifiers.js';
import type { JsonValue } from './json.js';
import {
  MAX_CHART_POINTS,
  MAX_MAP_FEATURES,
  MAX_SCENE_DEPTH,
  MAX_SCENE_NODES,
  MAX_TABLE_CELLS,
} from './limits.js';
import { DrawingNodeSchemaV1 } from './nodes/drawing.js';
import {
  ArtifactNodeSchemaV1,
  ChartNodeSchemaV1,
  CodeNodeSchemaV1,
  HitlNodeSchemaV1,
  ImageNodeSchemaV1,
  isTimestampCellV1,
  MapNodeSchemaV1,
  MarkdownNodeSchemaV1,
  ProgressNodeSchemaV1,
  StatusNodeSchemaV1,
  TableNodeSchemaV1,
} from './nodes/content.js';
import { createLayoutSchemasV1 } from './nodes/layout.js';

type UnknownNode = { id: string; type: string; [key: string]: unknown };

export type NodeBaseV1 = { id: NodeId; title?: ShortText };
export type PointV1 = { x: number; y: number };
export type DrawingStyleV1 = { stroke?: string; fill?: string; strokeWidth?: number; opacity?: number };
export type DrawingElementV1 =
  | { id: LocalFieldId; type: 'path'; points: PointV1[]; closed: boolean; style: DrawingStyleV1 }
  | { id: LocalFieldId; type: 'rect'; x: number; y: number; width: number; height: number; style: DrawingStyleV1 }
  | { id: LocalFieldId; type: 'ellipse'; cx: number; cy: number; rx: number; ry: number; style: DrawingStyleV1 }
  | { id: LocalFieldId; type: 'line'; from: PointV1; to: PointV1; style: DrawingStyleV1 }
  | { id: LocalFieldId; type: 'text'; x: number; y: number; text: ShortText; style: DrawingStyleV1 };

export type BoardNodeV1 =
  | (NodeBaseV1 & { type: 'layout.split'; direction: 'horizontal' | 'vertical'; gap: number; children: Array<{ node: BoardNodeV1; weight: number }> })
  | (NodeBaseV1 & { type: 'layout.grid'; columns: number; rows: number; gap: number; children: Array<{ node: BoardNodeV1; column: number; row: number; columnSpan: number; rowSpan: number }> })
  | (NodeBaseV1 & { type: 'layout.tabs'; activeTabId: TabId; tabs: Array<{ tabId: TabId; label: ShortText; node: BoardNodeV1 }> })
  | (NodeBaseV1 & { type: 'layout.canvas'; width: number; height: number; children: Array<{ node: BoardNodeV1; x: number; y: number; width: number; height: number; zIndex: number }> })
  | (NodeBaseV1 & { type: 'content.markdown'; markdown: string })
  | (NodeBaseV1 & { type: 'content.code'; language: string; code: string; showLineNumbers: boolean; wrap: boolean })
  | (NodeBaseV1 & { type: 'content.table'; columns: Array<{ key: LocalFieldId; label: ShortText; valueType: 'string' | 'number' | 'boolean' | 'datetime' }>; rows: Array<{ id: LocalFieldId; cells: Record<string, string | number | boolean | null> }> })
  | (NodeBaseV1 & { type: 'content.chart'; chartType: 'line' | 'bar' | 'area' | 'pie' | 'scatter'; xAxis: { valueType: 'category' | 'number' | 'datetime'; label?: ShortText }; yAxis: { label?: ShortText; min?: number; max?: number }; series: Array<{ id: LocalFieldId; label: ShortText; points: Array<{ x: string | number; y: number | null }> }> })
  | (NodeBaseV1 & { type: 'content.map'; viewport: { longitude: number; latitude: number; zoom: number }; data: { type: 'FeatureCollection'; features: Array<{ type: 'Feature'; id?: string | number; properties: Record<string, JsonValue>; geometry: { type: 'Point'; coordinates: [number, number] } | { type: 'LineString'; coordinates: Array<[number, number]> } | { type: 'Polygon'; coordinates: Array<Array<[number, number]>> } }> } })
  | (NodeBaseV1 & { type: 'content.drawing'; viewBox: { x: number; y: number; width: number; height: number }; elements: DrawingElementV1[] })
  | (NodeBaseV1 & { type: 'content.status'; status: 'neutral' | 'info' | 'success' | 'warning' | 'error'; label: ShortText; detail?: string })
  | (NodeBaseV1 & { type: 'content.image'; source: { type: 'artifact.resource'; artifact: ArtifactReferenceV1; path: string; sha256: string }; alt: string; caption?: ShortText; fit: 'contain' | 'cover' | 'fill' | 'none' })
  | (NodeBaseV1 & { type: 'content.progress'; state: 'active' | 'paused' | 'complete' | 'failed'; value: number | null; label: ShortText; detail?: ShortText })
  | (NodeBaseV1 & { type: 'content.hitl'; hitlRequestId: HitlRequestId })
  | (NodeBaseV1 & { type: 'content.artifact'; artifact: ArtifactReferenceV1; fallbackText: ShortText });

export type SplitNodeV1 = Extract<BoardNodeV1, { type: 'layout.split' }>;
export type GridNodeV1 = Extract<BoardNodeV1, { type: 'layout.grid' }>;
export type TabsNodeV1 = Extract<BoardNodeV1, { type: 'layout.tabs' }>;
export type CanvasNodeV1 = Extract<BoardNodeV1, { type: 'layout.canvas' }>;
export type MarkdownNodeV1 = Extract<BoardNodeV1, { type: 'content.markdown' }>;
export type CodeNodeV1 = Extract<BoardNodeV1, { type: 'content.code' }>;
export type TableNodeV1 = Extract<BoardNodeV1, { type: 'content.table' }>;
export type ChartNodeV1 = Extract<BoardNodeV1, { type: 'content.chart' }>;
export type MapNodeV1 = Extract<BoardNodeV1, { type: 'content.map' }>;
export type DrawingNodeV1 = Extract<BoardNodeV1, { type: 'content.drawing' }>;
export type StatusNodeV1 = Extract<BoardNodeV1, { type: 'content.status' }>;
export type ImageNodeV1 = Extract<BoardNodeV1, { type: 'content.image' }>;
export type ProgressNodeV1 = Extract<BoardNodeV1, { type: 'content.progress' }>;
export type HitlNodeV1 = Extract<BoardNodeV1, { type: 'content.hitl' }>;
export type ArtifactNodeV1 = Extract<BoardNodeV1, { type: 'content.artifact' }>;

export type SceneV1 = { protocolVersion: 1; type: 'scene'; root: BoardNodeV1 | null };

const BoardNodeSchemaInternalV1: z.ZodType<UnknownNode> = z.lazy(() => {
  const layouts = createLayoutSchemasV1(BoardNodeSchemaInternalV1);
  return z.discriminatedUnion('type', [
    layouts.split,
    layouts.grid,
    layouts.tabs,
    layouts.canvas,
    MarkdownNodeSchemaV1,
    CodeNodeSchemaV1,
    TableNodeSchemaV1,
    ChartNodeSchemaV1,
    MapNodeSchemaV1,
    DrawingNodeSchemaV1,
    StatusNodeSchemaV1,
    ImageNodeSchemaV1,
    ProgressNodeSchemaV1,
    HitlNodeSchemaV1,
    ArtifactNodeSchemaV1,
  ]) as z.ZodType<UnknownNode>;
});

type TraversalItem = { node: UnknownNode; path: Array<string | number>; depth: number };

const childItems = (node: UnknownNode, path: Array<string | number>, depth: number): TraversalItem[] => {
  if (node.type === 'layout.split' || node.type === 'layout.grid' || node.type === 'layout.canvas') {
    return ((node.children as Array<{ node: UnknownNode }> | undefined) ?? []).map((item, index) => ({ node: item.node, path: [...path, 'children', index, 'node'], depth: depth + 1 }));
  }
  if (node.type === 'layout.tabs') {
    return ((node.tabs as Array<{ node: UnknownNode }> | undefined) ?? []).map((item, index) => ({ node: item.node, path: [...path, 'tabs', index, 'node'], depth: depth + 1 }));
  }
  return [];
};

export const collectSceneNodesV1 = (root: UnknownNode | null): TraversalItem[] => {
  if (root === null) return [];
  const output: TraversalItem[] = [];
  const stack: TraversalItem[] = [{ node: root, path: ['root'], depth: 1 }];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) break;
    output.push(current);
    const children = childItems(current.node, current.path, current.depth);
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index];
      if (child) stack.push(child);
    }
  }
  return output;
};

const addLayoutIssue = (context: z.RefinementCtx, path: Array<string | number>, message: string) => context.addIssue({ code: z.ZodIssueCode.custom, path, message: `[INVALID_LAYOUT] ${message}` });

const validateNodeRelationsV1 = (root: UnknownNode | null, context: z.RefinementCtx, prefix: Array<string | number> = []): void => {
  const nodes = collectSceneNodesV1(root);
  if (nodes.length > MAX_SCENE_NODES) context.addIssue({ code: z.ZodIssueCode.custom, path: [...prefix, 'root'], message: '[LIMIT:maxSceneNodes] scene node count exceeded' });
  const ids = new Map<string, Array<string | number>>();
  for (const item of nodes) {
    const path = [...prefix, ...item.path];
    if (item.depth > MAX_SCENE_DEPTH) context.addIssue({ code: z.ZodIssueCode.custom, path, message: '[LIMIT:maxSceneDepth] scene depth exceeded' });
    const first = ids.get(item.node.id);
    if (first) context.addIssue({ code: z.ZodIssueCode.custom, path: [...path, 'id'], message: `[DUPLICATE_NODE_ID:${item.node.id}:${JSON.stringify(first)}] duplicate node ID` });
    else ids.set(item.node.id, [...path, 'id']);

    if (item.node.type === 'layout.tabs') {
      const tabs = item.node.tabs as Array<{ tabId: string }>;
      if (new Set(tabs.map((tab) => tab.tabId)).size !== tabs.length) addLayoutIssue(context, [...path, 'tabs'], 'tab IDs must be unique');
      if (!tabs.some((tab) => tab.tabId === item.node.activeTabId)) addLayoutIssue(context, [...path, 'activeTabId'], 'active tab is missing');
    } else if (item.node.type === 'layout.grid') {
      const placements = item.node.children as Array<{ column: number; row: number; columnSpan: number; rowSpan: number }>;
      const occupied = new Set<string>();
      placements.forEach((placement, index) => {
        if (placement.column + placement.columnSpan - 1 > (item.node.columns as number) || placement.row + placement.rowSpan - 1 > (item.node.rows as number)) addLayoutIssue(context, [...path, 'children', index], 'grid item is outside tracks');
        for (let row = placement.row; row < placement.row + placement.rowSpan; row += 1) for (let column = placement.column; column < placement.column + placement.columnSpan; column += 1) {
          const key = `${row}:${column}`;
          if (occupied.has(key)) addLayoutIssue(context, [...path, 'children', index], 'grid items overlap');
          occupied.add(key);
        }
      });
    } else if (item.node.type === 'layout.canvas') {
      const width = item.node.width as number;
      const height = item.node.height as number;
      (item.node.children as Array<{ x: number; y: number; width: number; height: number }>).forEach((placement, index) => {
        if (placement.x + placement.width > width || placement.y + placement.height > height) addLayoutIssue(context, [...path, 'children', index], 'canvas item is outside bounds');
      });
    } else if (item.node.type === 'content.table') {
      const columns = item.node.columns as Array<{ key: string; valueType: string }>;
      const rows = item.node.rows as Array<{ id: string; cells: Record<string, unknown> }>;
      const keys = columns.map((column) => column.key);
      if (new Set(keys).size !== keys.length) addLayoutIssue(context, [...path, 'columns'], 'table column keys must be unique');
      if (new Set(rows.map((row) => row.id)).size !== rows.length) addLayoutIssue(context, [...path, 'rows'], 'table row IDs must be unique');
      if (columns.length * rows.length > MAX_TABLE_CELLS) context.addIssue({ code: z.ZodIssueCode.custom, path: [...path, 'rows'], message: '[LIMIT:maxTableCells] table cell count exceeded' });
      rows.forEach((row, rowIndex) => {
        if (Object.keys(row.cells).length !== keys.length || keys.some((key) => !Object.hasOwn(row.cells, key))) addLayoutIssue(context, [...path, 'rows', rowIndex, 'cells'], 'table cells must match columns');
        columns.forEach((column) => {
          const value = row.cells[column.key];
          if (value === null) return;
          const valid = column.valueType === 'string' ? typeof value === 'string' : column.valueType === 'number' ? typeof value === 'number' : column.valueType === 'boolean' ? typeof value === 'boolean' : typeof value === 'string' && isTimestampCellV1(value);
          if (!valid) addLayoutIssue(context, [...path, 'rows', rowIndex, 'cells', column.key], 'table cell type does not match column');
        });
      });
    } else if (item.node.type === 'content.chart') {
      const chart = item.node as UnknownNode & { chartType: string; xAxis: { valueType: string }; yAxis: { min?: number; max?: number }; series: Array<{ points: Array<{ x: string | number; y: number | null }> }> };
      if (chart.yAxis.min !== undefined && chart.yAxis.max !== undefined && chart.yAxis.min > chart.yAxis.max) addLayoutIssue(context, [...path, 'yAxis', 'max'], 'axis bounds are invalid');
      const totalPoints = chart.series.reduce((total, series) => total + series.points.length, 0);
      if (totalPoints > MAX_CHART_POINTS) context.addIssue({ code: z.ZodIssueCode.custom, path: [...path, 'series'], message: '[LIMIT:maxChartPoints] chart point count exceeded' });
      if (chart.chartType === 'pie' && (chart.series.length !== 1 || chart.xAxis.valueType !== 'category' || chart.series[0]?.points.some((point) => point.y === null || point.y < 0))) addLayoutIssue(context, [...path, 'series'], 'pie chart requirements are invalid');
      if (chart.chartType === 'scatter' && chart.xAxis.valueType !== 'number') addLayoutIssue(context, [...path, 'xAxis', 'valueType'], 'scatter x axis must be numeric');
      chart.series.forEach((series, seriesIndex) => series.points.forEach((point, pointIndex) => {
        const validX = chart.xAxis.valueType === 'number' ? typeof point.x === 'number' : chart.xAxis.valueType === 'datetime' ? typeof point.x === 'string' && isTimestampCellV1(point.x) : typeof point.x === 'string';
        if (!validX) addLayoutIssue(context, [...path, 'series', seriesIndex, 'points', pointIndex, 'x'], 'chart x value does not match axis');
      }));
    } else if (item.node.type === 'content.map') {
      const features = ((item.node.data as { features: Array<{ geometry: { type: string; coordinates: unknown } }> }).features);
      if (features.length > MAX_MAP_FEATURES) context.addIssue({ code: z.ZodIssueCode.custom, path: [...path, 'data', 'features'], message: '[LIMIT:maxMapFeatures] map feature count exceeded' });
      features.forEach((feature, featureIndex) => {
        if (feature.geometry.type === 'Polygon') {
          (feature.geometry.coordinates as Array<Array<[number, number]>>).forEach((ring, ringIndex) => {
            const first = ring[0];
            const last = ring.at(-1);
            if (!first || !last || first[0] !== last[0] || first[1] !== last[1]) addLayoutIssue(context, [...path, 'data', 'features', featureIndex, 'geometry', 'coordinates', ringIndex], 'polygon ring must be closed');
          });
        }
      });
    } else if (item.node.type === 'content.progress') {
      const state = item.node.state as string;
      const value = item.node.value as number | null;
      if (state === 'complete' ? value !== 1 : (state !== 'active' && state !== 'paused') && value === null) addLayoutIssue(context, [...path, 'value'], 'progress value does not match state');
    }
  }
};

export const BoardNodeSchemaV1 = BoardNodeSchemaInternalV1.superRefine((node, context) => validateNodeRelationsV1(node, context, [])).describe('BoardNodeV1') as unknown as z.ZodType<BoardNodeV1>;

export const SceneSchemaV1 = z
  .object({ protocolVersion: z.literal(1), type: z.literal('scene'), root: BoardNodeSchemaInternalV1.nullable() })
  .strict()
  .superRefine((scene, context) => validateNodeRelationsV1(scene.root, context)) as unknown as z.ZodType<SceneV1>;
