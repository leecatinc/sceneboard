import { z } from 'zod';

import { createScalarTextSchemaV1, MediaIdSchemaV1 } from './identifiers.js';

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
