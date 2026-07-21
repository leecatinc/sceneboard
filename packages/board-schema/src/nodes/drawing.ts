import { z } from 'zod';

import { LocalFieldIdSchemaV1, ShortTextSchemaV1 } from '../identifiers.js';
import { MAX_DRAWING_ELEMENTS } from '../limits.js';
import { NodeBaseShapeV1, PointSchemaV1 } from './base.js';

const color = z.string().regex(/^#[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?$/);
export const DrawingStyleSchemaV1 = z
  .object({
    stroke: color.optional(),
    fill: color.optional(),
    strokeWidth: z.number().finite().positive().optional(),
    opacity: z.number().finite().min(0).max(1).optional(),
  })
  .strict();
const PathSchemaV1 = z
  .object({
    id: LocalFieldIdSchemaV1,
    type: z.literal('path'),
    points: z.array(PointSchemaV1).min(2),
    closed: z.boolean(),
    style: DrawingStyleSchemaV1,
  })
  .strict();
const RectSchemaV1 = z
  .object({
    id: LocalFieldIdSchemaV1,
    type: z.literal('rect'),
    x: z.number().finite(),
    y: z.number().finite(),
    width: z.number().finite().positive(),
    height: z.number().finite().positive(),
    style: DrawingStyleSchemaV1,
  })
  .strict();
const EllipseSchemaV1 = z
  .object({
    id: LocalFieldIdSchemaV1,
    type: z.literal('ellipse'),
    cx: z.number().finite(),
    cy: z.number().finite(),
    rx: z.number().finite().positive(),
    ry: z.number().finite().positive(),
    style: DrawingStyleSchemaV1,
  })
  .strict();
const LineSchemaV1 = z
  .object({
    id: LocalFieldIdSchemaV1,
    type: z.literal('line'),
    from: PointSchemaV1,
    to: PointSchemaV1,
    style: DrawingStyleSchemaV1,
  })
  .strict();
const TextSchemaV1 = z
  .object({
    id: LocalFieldIdSchemaV1,
    type: z.literal('text'),
    x: z.number().finite(),
    y: z.number().finite(),
    text: ShortTextSchemaV1,
    style: DrawingStyleSchemaV1,
  })
  .strict();
export const DrawingElementSchemaV1 = z.discriminatedUnion('type', [
  PathSchemaV1,
  RectSchemaV1,
  EllipseSchemaV1,
  LineSchemaV1,
  TextSchemaV1,
]);
export const DrawingNodeSchemaV1 = z
  .object({
    ...NodeBaseShapeV1,
    type: z.literal('content.drawing'),
    viewBox: z
      .object({
        x: z.number().finite(),
        y: z.number().finite(),
        width: z.number().finite().positive(),
        height: z.number().finite().positive(),
      })
      .strict(),
    elements: z.array(DrawingElementSchemaV1).max(MAX_DRAWING_ELEMENTS),
  })
  .strict();
