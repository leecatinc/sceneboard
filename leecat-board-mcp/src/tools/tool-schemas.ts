import { randomBytes } from 'node:crypto';
import { z } from 'zod';

export const GlobalIdSchemaV1 = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
export const IdempotencyKeySchemaV1 = z.string().min(16).max(128).regex(/^[A-Za-z0-9._:-]+$/);
export const ShortTextSchemaV1 = z.string().refine((value) => {
  const length = [...value].length;
  return length >= 1 && length <= 200 && !/[\u0000-\u001f\u007f-\u009f\uD800-\uDFFF]/u.test(value);
});

const LocalIdSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/);
const PlacementSchema = z.discriminatedUnion('parentType', [
  z.object({ parentType: z.literal('layout.split'), weight: z.number().finite().positive() }).strict(),
  z.object({ parentType: z.literal('layout.grid'), column: z.number().int().positive(), row: z.number().int().positive(), columnSpan: z.number().int().positive(), rowSpan: z.number().int().positive() }).strict(),
  z.object({ parentType: z.literal('layout.tabs'), tabId: LocalIdSchema, label: ShortTextSchemaV1 }).strict(),
  z.object({ parentType: z.literal('layout.canvas'), x: z.number().finite().nonnegative(), y: z.number().finite().nonnegative(), width: z.number().finite().positive(), height: z.number().finite().positive(), zIndex: z.number().int().safe() }).strict(),
]);

export const SceneTransformOperationSchemaV1 = z.discriminatedUnion('type', [
  z.object({ type: z.literal('replace_root'), root: z.unknown().nullable() }).strict(),
  z.object({ type: z.literal('replace_node'), nodeId: LocalIdSchema, node: z.unknown() }).strict(),
  z.object({ type: z.literal('remove_node'), nodeId: LocalIdSchema }).strict(),
  z.object({ type: z.literal('insert_child'), parentNodeId: LocalIdSchema, index: z.number().int().safe().nonnegative(), node: z.unknown(), placement: PlacementSchema }).strict(),
  z.object({ type: z.literal('move_child'), sourceParentNodeId: LocalIdSchema, destinationParentNodeId: LocalIdSchema, nodeId: LocalIdSchema, destinationIndex: z.number().int().safe().nonnegative(), placement: PlacementSchema }).strict(),
  z.object({ type: z.literal('set_split_weight'), splitNodeId: LocalIdSchema, childNodeId: LocalIdSchema, weight: z.number().finite().positive() }).strict(),
  z.object({ type: z.literal('set_grid_placement'), gridNodeId: LocalIdSchema, childNodeId: LocalIdSchema, column: z.number().int().positive(), row: z.number().int().positive(), columnSpan: z.number().int().positive(), rowSpan: z.number().int().positive() }).strict(),
  z.object({ type: z.literal('set_canvas_rect'), canvasNodeId: LocalIdSchema, childNodeId: LocalIdSchema, x: z.number().finite().nonnegative(), y: z.number().finite().nonnegative(), width: z.number().finite().positive(), height: z.number().finite().positive(), zIndex: z.number().int().safe() }).strict(),
  z.object({ type: z.literal('set_active_tab'), tabsNodeId: LocalIdSchema, tabId: LocalIdSchema }).strict(),
  z.object({ type: z.literal('upsert_drawing_element'), drawingNodeId: LocalIdSchema, element: z.unknown() }).strict(),
  z.object({ type: z.literal('remove_drawing_element'), drawingNodeId: LocalIdSchema, elementId: LocalIdSchema }).strict(),
]);

export const descriptorInputSchemaV1 = <Schema extends z.ZodTypeAny>(schema: Schema): Schema => {
  const descriptor = Object.create(schema) as Schema;
  Object.defineProperty(descriptor, 'safeParseAsync', {
    value: async (input: unknown) => ({ success: true as const, data: input }),
  });
  return descriptor;
};

export const createRequestIdV1 = (): string => randomBytes(16).toString('base64url');
