import { z } from 'zod';

import { MAX_MAP_FEATURES } from '../limits.js';

const PositionSchemaV1 = z.tuple([
  z.number().finite().min(-180).max(180),
  z.number().finite().min(-90).max(90),
]);
const PointGeometrySchemaV1 = z
  .object({ type: z.literal('Point'), coordinates: PositionSchemaV1 })
  .strict();
const LineGeometrySchemaV1 = z
  .object({ type: z.literal('LineString'), coordinates: z.array(PositionSchemaV1).min(2) })
  .strict();
const PolygonGeometrySchemaV1 = z
  .object({
    type: z.literal('Polygon'),
    coordinates: z.array(z.array(PositionSchemaV1).min(4)).min(1),
  })
  .strict();
export const GeoJsonGeometrySchemaV1 = z.discriminatedUnion('type', [
  PointGeometrySchemaV1,
  LineGeometrySchemaV1,
  PolygonGeometrySchemaV1,
]);
export const GeoJsonFeatureCollectionSchemaV1 = z
  .object({
    type: z.literal('FeatureCollection'),
    features: z
      .array(
        z
          .object({
            type: z.literal('Feature'),
            id: z.union([z.string(), z.number().finite()]).optional(),
            properties: z.record(z.unknown()),
            geometry: GeoJsonGeometrySchemaV1,
          })
          .strict(),
      )
      .max(MAX_MAP_FEATURES),
  })
  .strict();
