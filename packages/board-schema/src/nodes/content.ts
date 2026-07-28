import { z } from 'zod';

import {
  ArtifactDigestSchemaV1,
  ArtifactPathSchemaV1,
  ArtifactReferenceSchemaV1,
} from '../artifacts.js';
import {
  ContentTextSchemaV1,
  HitlRequestIdSchemaV1,
  LocalFieldIdSchemaV1,
  ShortTextSchemaV1,
  TimestampSchemaV1,
} from '../identifiers.js';
import { scalarLengthV1 } from '../json.js';
import { MediaCaptionSchemaV1, MediaSourceSchemaV1 } from '../media.js';
import {
  MAX_CHART_POINTS,
  MAX_CHART_SERIES,
  MAX_CODE_CHARS,
  MAX_IMAGE_ALT_CHARS,
  MAX_MARKDOWN_CHARS,
  MAX_TABLE_COLUMNS,
  MAX_TABLE_ROWS,
} from '../limits.js';
import { NodeBaseShapeV1 } from './base.js';
import { GeoJsonFeatureCollectionSchemaV1 } from './geojson.js';

const MarkdownTextSchemaV1 = ContentTextSchemaV1.refine(
  (value) => scalarLengthV1(value) <= MAX_MARKDOWN_CHARS,
  '[LIMIT:maxMarkdownChars] markdown text is too long',
);
const CodeTextSchemaV1 = ContentTextSchemaV1.refine(
  (value) => scalarLengthV1(value) <= MAX_CODE_CHARS,
  '[LIMIT:maxCodeChars] code text is too long',
);
const ImageAltSchemaV1 = ContentTextSchemaV1.refine(
  (value) => scalarLengthV1(value) <= MAX_IMAGE_ALT_CHARS,
  '[LIMIT:maxImageAltChars] image alt text is too long',
);

export const MarkdownNodeSchemaV1 = z
  .object({
    ...NodeBaseShapeV1,
    type: z.literal('content.markdown'),
    markdown: MarkdownTextSchemaV1,
  })
  .strict();
export const CodeNodeSchemaV1 = z
  .object({
    ...NodeBaseShapeV1,
    type: z.literal('content.code'),
    language: z.string().regex(/^[A-Za-z0-9_+.#-]{1,64}$/),
    code: CodeTextSchemaV1,
    showLineNumbers: z.boolean(),
    wrap: z.boolean(),
  })
  .strict();

const TableColumnSchemaV1 = z
  .object({
    key: LocalFieldIdSchemaV1,
    label: ShortTextSchemaV1,
    valueType: z.enum(['string', 'number', 'boolean', 'datetime']),
  })
  .strict();
const TableCellSchemaV1 = z.union([z.string(), z.number().finite(), z.boolean(), z.null()]);
const TableRowSchemaV1 = z
  .object({ id: LocalFieldIdSchemaV1, cells: z.record(LocalFieldIdSchemaV1, TableCellSchemaV1) })
  .strict();
export const TableNodeSchemaV1 = z
  .object({
    ...NodeBaseShapeV1,
    type: z.literal('content.table'),
    columns: z.array(TableColumnSchemaV1).min(1).max(MAX_TABLE_COLUMNS),
    rows: z.array(TableRowSchemaV1).max(MAX_TABLE_ROWS),
  })
  .strict();

const ChartPointSchemaV1 = z
  .object({ x: z.union([z.string(), z.number().finite()]), y: z.number().finite().nullable() })
  .strict();
const ChartSeriesSchemaV1 = z
  .object({
    id: LocalFieldIdSchemaV1,
    label: ShortTextSchemaV1,
    points: z.array(ChartPointSchemaV1).max(MAX_CHART_POINTS),
  })
  .strict();
export const ChartNodeSchemaV1 = z
  .object({
    ...NodeBaseShapeV1,
    type: z.literal('content.chart'),
    chartType: z.enum(['line', 'bar', 'area', 'pie', 'scatter']),
    xAxis: z
      .object({
        valueType: z.enum(['category', 'number', 'datetime']),
        label: ShortTextSchemaV1.optional(),
      })
      .strict(),
    yAxis: z
      .object({
        label: ShortTextSchemaV1.optional(),
        min: z.number().finite().optional(),
        max: z.number().finite().optional(),
      })
      .strict(),
    series: z.array(ChartSeriesSchemaV1).min(1).max(MAX_CHART_SERIES),
  })
  .strict();

export const MapNodeSchemaV1 = z
  .object({
    ...NodeBaseShapeV1,
    type: z.literal('content.map'),
    viewport: z
      .object({
        longitude: z.number().finite().min(-180).max(180),
        latitude: z.number().finite().min(-90).max(90),
        zoom: z.number().finite().min(0).max(24),
      })
      .strict(),
    data: GeoJsonFeatureCollectionSchemaV1,
  })
  .strict();
export const StatusNodeSchemaV1 = z
  .object({
    ...NodeBaseShapeV1,
    type: z.literal('content.status'),
    status: z.enum(['neutral', 'info', 'success', 'warning', 'error']),
    label: ShortTextSchemaV1,
    detail: MarkdownTextSchemaV1.optional(),
  })
  .strict();
const ArtifactImageSourceSchemaV1 = z
  .object({
    type: z.literal('artifact.resource'),
    artifact: ArtifactReferenceSchemaV1,
    path: ArtifactPathSchemaV1,
    sha256: ArtifactDigestSchemaV1,
  })
  .strict();

export const ImageNodeSchemaV1 = z
  .object({
    ...NodeBaseShapeV1,
    type: z.literal('content.image'),
    source: z.union([ArtifactImageSourceSchemaV1, MediaSourceSchemaV1]),
    decorative: z.boolean().optional(),
    alt: ImageAltSchemaV1,
    caption: MediaCaptionSchemaV1.optional(),
    fit: z.enum(['contain', 'cover', 'fill', 'none']),
  })
  .strict();
export const ProgressNodeSchemaV1 = z
  .object({
    ...NodeBaseShapeV1,
    type: z.literal('content.progress'),
    state: z.enum(['active', 'paused', 'complete', 'failed']),
    value: z.number().finite().min(0).max(1).nullable(),
    label: ShortTextSchemaV1,
    detail: ShortTextSchemaV1.optional(),
  })
  .strict();
export const HitlNodeSchemaV1 = z
  .object({
    ...NodeBaseShapeV1,
    type: z.literal('content.hitl'),
    hitlRequestId: HitlRequestIdSchemaV1,
  })
  .strict();
export const ArtifactNodeSchemaV1 = z
  .object({
    ...NodeBaseShapeV1,
    type: z.literal('content.artifact'),
    artifact: ArtifactReferenceSchemaV1,
    fallbackText: ShortTextSchemaV1,
  })
  .strict();

export const isTimestampCellV1 = (value: string): boolean =>
  TimestampSchemaV1.safeParse(value).success;
