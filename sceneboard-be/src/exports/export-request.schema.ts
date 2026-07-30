import { z } from 'zod';

export const ExportFormatSchemaV1 = z.enum(['pdf', 'pptx']);
const ExportRevisionIdSchemaV1 = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/u);

export const ExportRequestSchemaV1 = z
  .object({
    format: ExportFormatSchemaV1,
    revisionId: ExportRevisionIdSchemaV1.nullable(),
  })
  .strict();

export type ExportFormatV1 = z.infer<typeof ExportFormatSchemaV1>;
export type ExportRequestV1 = z.infer<typeof ExportRequestSchemaV1>;

export const EXPORT_MAX_PAGES_V1 = 200;
export const EXPORT_PROJECTION_MAX_BYTES_V1 = 1_048_576;
export const EXPORT_RESOURCE_MAX_COUNT_V1 = 256;
export const EXPORT_RESOURCE_MAX_BYTES_V1 = 16_777_216;
export const EXPORT_RESOURCE_TOTAL_MAX_BYTES_V1 = 268_435_456;
export const EXPORT_RENDERED_PAGE_MAX_BYTES_V1 = 33_554_432;
export const EXPORT_RENDERED_PAGES_TOTAL_MAX_BYTES_V1 = 268_435_456;
export const EXPORT_RENDER_TIMEOUT_MS_V1 = 60_000;
export const EXPORT_ENCODE_TIMEOUT_MS_V1 = 30_000;
export const EXPORT_TOTAL_TIMEOUT_MS_V1 = 120_000;
