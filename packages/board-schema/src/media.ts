import { z } from 'zod';

import { createScalarTextSchemaV1, MediaIdSchemaV1, RequestIdSchemaV1 } from './identifiers.js';
import { MAX_MEDIA_BYTES } from './limits.js';

export const MAX_MEDIA_ALT_CHARS = 500;
export const MAX_MEDIA_CAPTION_CHARS = 500;

export const MediaAltSchemaV1 = createScalarTextSchemaV1(1, MAX_MEDIA_ALT_CHARS);
export const MediaCaptionSchemaV1 = createScalarTextSchemaV1(1, MAX_MEDIA_CAPTION_CHARS);
export const MediaSourceSchemaV1 = z
  .object({
    type: z.literal('media'),
    mediaId: MediaIdSchemaV1,
  })
  .strict();

export type MediaSourceV1 = z.infer<typeof MediaSourceSchemaV1>;

export const MEDIA_MIME_TYPES_V1 = ['image/png', 'image/jpeg', 'image/webp'] as const;
export const MediaMimeSchemaV1 = z.enum(MEDIA_MIME_TYPES_V1);
export const MediaSha256SchemaV1 = z.string().regex(/^[0-9a-f]{64}$/u);
export const MediaIngestResultSchemaV1 = z
  .object({
    protocolVersion: z.literal(1),
    type: z.literal('media.ingest.result'),
    requestId: RequestIdSchemaV1,
    status: z.enum(['created', 'replayed']),
    media: z
      .object({
        mediaId: MediaIdSchemaV1,
        sha256: MediaSha256SchemaV1,
        mime: MediaMimeSchemaV1,
        width: z.number().int().positive().max(16_384),
        height: z.number().int().positive().max(16_384),
        bytes: z.number().int().positive().max(MAX_MEDIA_BYTES),
      })
      .strict(),
  })
  .strict();

export type MediaMimeV1 = z.infer<typeof MediaMimeSchemaV1>;
export type MediaIngestResultV1 = z.infer<typeof MediaIngestResultSchemaV1>;
