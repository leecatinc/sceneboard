import { z } from 'zod';

import { PageIdSchemaV1, TimestampSchemaV1 } from './identifiers.js';
import { PublicContextIdSchemaV1 } from './public-shares.js';

export const PUBLIC_PRESENTATION_MAX_SESSIONS_V1 = 5;
export const PUBLIC_PRESENTATION_MAX_STROKES_V1 = 64;
export const PUBLIC_PRESENTATION_MAX_POINTS_PER_STROKE_V1 = 128;
export const PUBLIC_PRESENTATION_MAX_POINTS_V1 = 1_024;

export const PublicPresentationSessionIdSchemaV1 = PublicContextIdSchemaV1;
export const PublicPresentationRoleSchemaV1 = z.enum(['presenter', 'viewer']);
export const PublicPresentationStatusSchemaV1 = z.enum(['active', 'ended']);

export const PublicPresentationPointSchemaV1 = z
  .object({
    x: z.number().finite().min(0).max(1),
    y: z.number().finite().min(0).max(1),
  })
  .strict();

export const PublicPresentationStrokeSchemaV1 = z
  .object({
    id: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[\x21-\x7e]+$/u),
    points: z
      .array(PublicPresentationPointSchemaV1)
      .min(1)
      .max(PUBLIC_PRESENTATION_MAX_POINTS_PER_STROKE_V1),
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/u),
    width: z.union([z.literal(2), z.literal(4), z.literal(8)]),
  })
  .strict();

export const PublicPresentationAnnotationSchemaV1 = z
  .object({
    pageId: PageIdSchemaV1,
    strokes: z.array(PublicPresentationStrokeSchemaV1).max(PUBLIC_PRESENTATION_MAX_STROKES_V1),
  })
  .strict()
  .superRefine((annotation, context) => {
    const totalPoints = annotation.strokes.reduce((sum, stroke) => sum + stroke.points.length, 0);
    if (totalPoints > PUBLIC_PRESENTATION_MAX_POINTS_V1)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['strokes'],
        message: 'presentation point limit exceeded',
      });
    const ids = new Set<string>();
    annotation.strokes.forEach((stroke, index) => {
      if (ids.has(stroke.id))
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['strokes', index, 'id'],
          message: 'duplicate presentation stroke ID',
        });
      ids.add(stroke.id);
    });
  });

export const PublicPresentationSessionSummarySchemaV1 = z
  .object({
    sessionId: PublicPresentationSessionIdSchemaV1,
    role: PublicPresentationRoleSchemaV1,
    startedAt: TimestampSchemaV1,
    updatedAt: TimestampSchemaV1,
    expiresAt: TimestampSchemaV1,
  })
  .strict();

export const PublicPresentationSessionListSchemaV1 = z
  .object({
    sessions: z
      .array(PublicPresentationSessionSummarySchemaV1)
      .max(PUBLIC_PRESENTATION_MAX_SESSIONS_V1),
  })
  .strict();

export const PublicPresentationStartRequestSchemaV1 = z
  .object({ currentPageId: PageIdSchemaV1 })
  .strict();

export const PublicPresentationSnapshotSchemaV1 = z
  .object({
    sessionId: PublicPresentationSessionIdSchemaV1,
    role: PublicPresentationRoleSchemaV1,
    status: PublicPresentationStatusSchemaV1,
    version: z.number().int().safe().min(0),
    currentPageId: PageIdSchemaV1,
    annotation: PublicPresentationAnnotationSchemaV1,
    startedAt: TimestampSchemaV1,
    updatedAt: TimestampSchemaV1,
    expiresAt: TimestampSchemaV1,
  })
  .strict()
  .superRefine((snapshot, context) => {
    if (snapshot.annotation.pageId !== snapshot.currentPageId)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['annotation', 'pageId'],
        message: 'annotation page must match current page',
      });
  });

export const PublicPresentationUpdateRequestSchemaV1 = z
  .object({
    expectedVersion: z.number().int().safe().min(0),
    currentPageId: PageIdSchemaV1,
    annotation: PublicPresentationAnnotationSchemaV1,
  })
  .strict()
  .superRefine((update, context) => {
    if (update.annotation.pageId !== update.currentPageId)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['annotation', 'pageId'],
        message: 'annotation page must match current page',
      });
  });

export const PublicPresentationEventSchemaV1 = z
  .object({
    type: z.literal('presentation.state.v1'),
    snapshot: PublicPresentationSnapshotSchemaV1,
  })
  .strict();

export const PublicPresentationEndResultSchemaV1 = z
  .object({
    sessionId: PublicPresentationSessionIdSchemaV1,
    status: z.literal('ended'),
  })
  .strict();

export type PublicPresentationSessionIdV1 = z.infer<typeof PublicPresentationSessionIdSchemaV1>;
export type PublicPresentationRoleV1 = z.infer<typeof PublicPresentationRoleSchemaV1>;
export type PublicPresentationPointV1 = z.infer<typeof PublicPresentationPointSchemaV1>;
export type PublicPresentationStrokeV1 = z.infer<typeof PublicPresentationStrokeSchemaV1>;
export type PublicPresentationAnnotationV1 = z.infer<typeof PublicPresentationAnnotationSchemaV1>;
export type PublicPresentationSessionSummaryV1 = z.infer<
  typeof PublicPresentationSessionSummarySchemaV1
>;
export type PublicPresentationSessionListV1 = z.infer<typeof PublicPresentationSessionListSchemaV1>;
export type PublicPresentationStartRequestV1 = z.infer<
  typeof PublicPresentationStartRequestSchemaV1
>;
export type PublicPresentationSnapshotV1 = z.infer<typeof PublicPresentationSnapshotSchemaV1>;
export type PublicPresentationUpdateRequestV1 = z.infer<
  typeof PublicPresentationUpdateRequestSchemaV1
>;
export type PublicPresentationEventV1 = z.infer<typeof PublicPresentationEventSchemaV1>;
export type PublicPresentationEndResultV1 = z.infer<typeof PublicPresentationEndResultSchemaV1>;
