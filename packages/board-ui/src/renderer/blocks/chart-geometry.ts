import type { ChartNodeV1 } from '@leecat-board/board-schema';

export type ChartGeometryPointV1 = {
  seriesId: string;
  x: number;
  y: number | null;
  sourceX: string | number;
  sourceY: number | null;
};

export type ChartGeometryV1 = {
  tableOnly: boolean;
  points: ChartGeometryPointV1[];
  categoryDomain: string[];
  yMinimum: number | null;
  yMaximum: number | null;
};

const chartXValues = (node: ChartNodeV1): Array<string | number> => node.series.flatMap((series) => series.points.map((point) => point.x));

const projectedX = (node: ChartNodeV1, value: string | number, categories: readonly string[]): number => {
  if (node.xAxis.valueType === 'category') {
    const index = categories.indexOf(String(value));
    return categories.length <= 1 ? 50 : index / (categories.length - 1) * 100;
  }
  const values = chartXValues(node).map((source) => (
    node.xAxis.valueType === 'datetime' ? Date.parse(String(source)) : Number(source)
  ));
  const numeric = node.xAxis.valueType === 'datetime' ? Date.parse(String(value)) : Number(value);
  const minimum = Math.min(...values);
  const maximum = Math.max(...values);
  return maximum === minimum ? 50 : (numeric - minimum) / (maximum - minimum) * 100;
};

const yDomain = (node: ChartNodeV1): [number, number] | null => {
  const values = node.series.flatMap((series) => series.points.map((point) => point.y)).filter((value): value is number => value !== null);
  if (values.length === 0) return null;
  const inferredMinimum = Math.min(...values);
  const inferredMaximum = Math.max(...values);
  let minimum = node.yAxis.min ?? inferredMinimum;
  let maximum = node.yAxis.max ?? inferredMaximum;
  if (node.yAxis.min !== undefined && node.yAxis.max !== undefined && minimum === maximum) return null;
  if (minimum === maximum) {
    const delta = Math.max(1, Math.abs(minimum) * 0.01);
    minimum -= delta;
    maximum += delta;
  }
  if (node.yAxis.min !== undefined && maximum <= minimum) maximum = minimum + Math.max(1, Math.abs(minimum) * 0.01);
  if (node.yAxis.max !== undefined && minimum >= maximum) minimum = maximum - Math.max(1, Math.abs(maximum) * 0.01);
  return [minimum, maximum];
};

export const buildChartGeometryV1 = (node: ChartNodeV1): ChartGeometryV1 => {
  const categoryDomain = node.xAxis.valueType === 'category'
    ? [...new Set(chartXValues(node).map(String))]
    : [];
  const domain = yDomain(node);
  if (domain === null) return { tableOnly: true, points: [], categoryDomain, yMinimum: null, yMaximum: null };
  const [minimum, maximum] = domain;
  const points = node.series.flatMap((series) => series.points.map((point) => ({
    seriesId: series.id,
    x: projectedX(node, point.x, categoryDomain),
    y: point.y === null ? null : 100 - ((point.y - minimum) / (maximum - minimum) * 100),
    sourceX: point.x,
    sourceY: point.y,
  })));
  const safe = points.every((point) => Number.isFinite(point.x) && (point.y === null || Number.isFinite(point.y)));
  return { tableOnly: !safe, points: safe ? points : [], categoryDomain, yMinimum: minimum, yMaximum: maximum };
};
