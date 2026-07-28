import { z } from 'zod';

import {
  BoardIdSchemaV1,
  GlobalIdStringSchemaV1,
  IdempotencyKeySchemaV1,
  PageIdSchemaV1,
  RevisionIdSchemaV1,
  ShortTextSchemaV1,
  TimestampSchemaV1,
} from './identifiers.js';

const DateOnlySchemaV1 = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/u)
  .refine((value) => {
    const instant = Date.parse(`${value}T00:00:00.000Z`);
    return Number.isFinite(instant) && new Date(instant).toISOString().slice(0, 10) === value;
  });

const CountSchemaV1 = z.number().int().safe().nonnegative();
const GenerationSchemaV1 = z.number().int().safe().positive();
const ViewContextIdSchemaV1 = GlobalIdStringSchemaV1;
const ViewCsrfTokenSchemaV1 = z
  .string()
  .min(32)
  .max(512)
  .regex(/^[\x21-\x7e]+$/u);

export const ShareAnalyticsContextRequestSchemaV1 = z.object({}).strict();

export const ShareAnalyticsContextSchemaV1 = z
  .object({
    viewContextId: ViewContextIdSchemaV1,
    revisionId: RevisionIdSchemaV1,
    publicationGeneration: GenerationSchemaV1,
    accessGeneration: GenerationSchemaV1,
    pageIds: z.array(PageIdSchemaV1).min(1).max(1_000),
    expiresAt: TimestampSchemaV1,
    csrfToken: ViewCsrfTokenSchemaV1,
  })
  .strict()
  .superRefine((value, context) => {
    const seen = new Set<string>();
    value.pageIds.forEach((pageId, index) => {
      if (seen.has(pageId))
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['pageIds', index],
          message: 'duplicate page ID',
        });
      seen.add(pageId);
    });
  });

export const ShareAnalyticsEventSchemaV1 = z
  .object({
    viewContextId: ViewContextIdSchemaV1,
    eventKind: z.enum(['first-visible', 'page-visible']),
    pageId: PageIdSchemaV1,
    idempotencyKey: IdempotencyKeySchemaV1,
  })
  .strict();

export const ShareAnalyticsEventResultSchemaV1 = z
  .object({
    status: z.enum(['counted', 'deduped']),
    replayed: z.boolean(),
  })
  .strict();

const AggregateSummarySchemaV1 = z
  .object({
    boardOpens: CountSchemaV1,
    pageViews: CountSchemaV1,
    estimatedDailyReach: CountSchemaV1,
    lastAggregatedAt: TimestampSchemaV1.nullable(),
  })
  .strict();

export const ShareAnalyticsPageReportSchemaV1 = z
  .object({
    pageId: PageIdSchemaV1,
    pageOrdinal: z.number().int().safe().nonnegative(),
    titleLabel: ShortTextSchemaV1,
    pageViews: CountSchemaV1,
    pageReachBasisPoints: z.number().int().min(0).max(10_000).nullable(),
  })
  .strict();

export const ShareAnalyticsPublicationReportSchemaV1 = z
  .object({
    shareId: GlobalIdStringSchemaV1,
    publicationGeneration: GenerationSchemaV1,
    revisionId: RevisionIdSchemaV1,
    ...AggregateSummarySchemaV1.shape,
    pages: z.array(ShareAnalyticsPageReportSchemaV1).max(1_000),
  })
  .strict();

export const ShareAnalyticsReportSchemaV1 = z
  .object({
    boardId: BoardIdSchemaV1,
    from: DateOnlySchemaV1,
    to: DateOnlySchemaV1,
    totals: AggregateSummarySchemaV1,
    publications: z.array(ShareAnalyticsPublicationReportSchemaV1).max(10_000),
  })
  .strict()
  .refine((value) => value.from <= value.to, {
    path: ['to'],
    message: 'to must be on or after from',
  });

export const SHARE_ANALYTICS_ERROR_CODES_V1 = [
  'INVALID_PAYLOAD',
  'UNAUTHENTICATED',
  'CSRF_INVALID',
  'SHARE_VIEW_UNAVAILABLE',
  'BOARD_NOT_FOUND',
  'IDEMPOTENCY_KEY_REUSED',
  'RATE_LIMITED',
  'SERVICE_UNAVAILABLE',
] as const;

export const ShareAnalyticsErrorCodeSchemaV1 = z.enum(SHARE_ANALYTICS_ERROR_CODES_V1);
export const ShareAnalyticsErrorEnvelopeSchemaV1 = z
  .object({
    error: z
      .object({
        code: ShareAnalyticsErrorCodeSchemaV1,
        message: z.string().min(1).max(128),
        requestId: GlobalIdStringSchemaV1,
      })
      .strict(),
  })
  .strict();

export type ShareAnalyticsContextV1 = z.infer<typeof ShareAnalyticsContextSchemaV1>;
export type ShareAnalyticsEventV1 = z.infer<typeof ShareAnalyticsEventSchemaV1>;
export type ShareAnalyticsEventResultV1 = z.infer<typeof ShareAnalyticsEventResultSchemaV1>;
export type ShareAnalyticsReportV1 = z.infer<typeof ShareAnalyticsReportSchemaV1>;
export type ShareAnalyticsErrorCodeV1 = z.infer<typeof ShareAnalyticsErrorCodeSchemaV1>;
