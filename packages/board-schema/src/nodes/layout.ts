import { z } from 'zod';

import { ShortTextSchemaV1, TabIdSchemaV1 } from '../identifiers.js';
import {
  MAX_CANVAS_EXTENT,
  MAX_CANVAS_ITEMS,
  MAX_GRID_COLUMNS,
  MAX_GRID_ITEMS,
  MAX_GRID_ROWS,
  MAX_SPLIT_CHILDREN,
  MAX_TABS,
} from '../limits.js';
import { NodeBaseShapeV1 } from './base.js';

export const createLayoutSchemasV1 = (node: z.ZodTypeAny) => {
  const split = z
    .object({
      ...NodeBaseShapeV1,
      type: z.literal('layout.split'),
      direction: z.enum(['horizontal', 'vertical']),
      gap: z.number().finite().min(0).max(MAX_CANVAS_EXTENT),
      children: z
        .array(z.object({ node, weight: z.number().finite().positive() }).strict())
        .min(2)
        .max(MAX_SPLIT_CHILDREN),
    })
    .strict();
  const grid = z
    .object({
      ...NodeBaseShapeV1,
      type: z.literal('layout.grid'),
      columns: z.number().int().min(1).max(MAX_GRID_COLUMNS),
      rows: z.number().int().min(1).max(MAX_GRID_ROWS),
      gap: z.number().finite().min(0).max(MAX_CANVAS_EXTENT),
      children: z
        .array(
          z
            .object({
              node,
              column: z.number().int().min(1),
              row: z.number().int().min(1),
              columnSpan: z.number().int().min(1),
              rowSpan: z.number().int().min(1),
            })
            .strict(),
        )
        .min(1)
        .max(MAX_GRID_ITEMS),
    })
    .strict();
  const tabs = z
    .object({
      ...NodeBaseShapeV1,
      type: z.literal('layout.tabs'),
      activeTabId: TabIdSchemaV1,
      tabs: z
        .array(z.object({ tabId: TabIdSchemaV1, label: ShortTextSchemaV1, node }).strict())
        .min(1)
        .max(MAX_TABS),
    })
    .strict();
  const canvas = z
    .object({
      ...NodeBaseShapeV1,
      type: z.literal('layout.canvas'),
      width: z.number().finite().positive().max(MAX_CANVAS_EXTENT),
      height: z.number().finite().positive().max(MAX_CANVAS_EXTENT),
      children: z
        .array(
          z
            .object({
              node,
              x: z.number().finite().min(0),
              y: z.number().finite().min(0),
              width: z.number().finite().positive(),
              height: z.number().finite().positive(),
              zIndex: z.number().int().safe(),
            })
            .strict(),
        )
        .min(1)
        .max(MAX_CANVAS_ITEMS),
    })
    .strict();
  return { split, grid, tabs, canvas };
};
