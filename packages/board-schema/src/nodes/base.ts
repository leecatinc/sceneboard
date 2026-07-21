import { z } from 'zod';

import { NodeIdSchemaV1, ShortTextSchemaV1 } from '../identifiers.js';

export const NodeBaseShapeV1 = {
  id: NodeIdSchemaV1,
  title: ShortTextSchemaV1.optional(),
};

export const PointSchemaV1 = z.object({ x: z.number().finite(), y: z.number().finite() }).strict();
