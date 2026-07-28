import { z } from 'zod';

import {
  SHARE_ACCESS_POLICIES_V1,
  SHARE_ERROR_CODES_V1,
  SHARE_MANAGEMENT_OPERATION_TYPES_V1,
  SHARE_STATUSES_V1,
} from './catalogs.js';
import { GlobalIdStringSchemaV1, RevisionIdSchemaV1, TimestampSchemaV1 } from './identifiers.js';

export const ShareStatusSchemaV1 = z.enum(SHARE_STATUSES_V1);
export const ShareAccessPolicySchemaV1 = z.enum(SHARE_ACCESS_POLICIES_V1);
export const ShareManagementOperationSchemaV1 = z.enum(SHARE_MANAGEMENT_OPERATION_TYPES_V1);
export const ShareIdempotencyKeySchemaV1 = z
  .string()
  .min(16)
  .max(128)
  .regex(/^[\x20-\x7e]+$/u);
export const ShareLinkTokenSchemaV1 = z.string().regex(/^[A-Za-z0-9_-]{43}$/u);

export const ShareManagementViewSchemaV1 = z
  .object({
    shareId: GlobalIdStringSchemaV1,
    status: ShareStatusSchemaV1,
    accessPolicy: ShareAccessPolicySchemaV1,
    pinnedRevisionId: RevisionIdSchemaV1,
    publicationGeneration: z.number().int().safe().positive(),
    accessGeneration: z.number().int().safe().positive(),
    version: z.number().int().safe().positive(),
    createdAt: TimestampSchemaV1,
    updatedAt: TimestampSchemaV1,
  })
  .strict();

export const ShareListResultSchemaV1 = z
  .object({ shares: z.array(ShareManagementViewSchemaV1).max(1) })
  .strict();

export const SharePublishRequestSchemaV1 = z
  .object({ pinnedRevisionId: RevisionIdSchemaV1 })
  .strict();
export const ShareUpdateRequestSchemaV1 = z
  .object({
    pinnedRevisionId: RevisionIdSchemaV1,
    expectedVersion: z.number().int().safe().positive(),
  })
  .strict();
export const ShareVersionRequestSchemaV1 = z
  .object({ expectedVersion: z.number().int().safe().positive() })
  .strict();
export const ShareFingerprintInputSchemaV1 = z
  .object({
    operation: ShareManagementOperationSchemaV1,
    shareId: GlobalIdStringSchemaV1.nullable(),
    expectedVersion: z.number().int().safe().positive().nullable(),
    pinnedRevisionId: RevisionIdSchemaV1.nullable(),
  })
  .strict();

export const ShareSecretReplayResultSchemaV1 = z
  .object({
    status: z.enum(['already-created', 'already-republished', 'already-rotated']),
    shareId: GlobalIdStringSchemaV1,
    copySecretAvailable: z.literal(false),
    rotateRequired: z.literal(true),
  })
  .strict();

export const SharePublishSuccessSchemaV1 = z
  .object({
    status: z.enum(['created', 'republished']),
    share: ShareManagementViewSchemaV1,
    linkToken: ShareLinkTokenSchemaV1,
  })
  .strict();
export const ShareRotateSuccessSchemaV1 = z
  .object({
    status: z.literal('rotated'),
    share: ShareManagementViewSchemaV1,
    linkToken: ShareLinkTokenSchemaV1,
  })
  .strict();
export const ShareUpdateSuccessSchemaV1 = z
  .object({
    status: z.enum(['updated', 'unchanged']),
    share: ShareManagementViewSchemaV1,
  })
  .strict();

export const ShareErrorSchemaV1 = z
  .object({
    code: z.enum(SHARE_ERROR_CODES_V1),
    message: z.string().min(1).max(256),
    requestId: GlobalIdStringSchemaV1,
  })
  .strict();
export const ShareErrorEnvelopeSchemaV1 = z.object({ error: ShareErrorSchemaV1 }).strict();

export type ShareFingerprintInputV1 = z.infer<typeof ShareFingerprintInputSchemaV1>;
export type ShareManagementViewV1 = z.infer<typeof ShareManagementViewSchemaV1>;
export type ShareListResultV1 = z.infer<typeof ShareListResultSchemaV1>;
export type SharePublishRequestV1 = z.infer<typeof SharePublishRequestSchemaV1>;
export type ShareUpdateRequestV1 = z.infer<typeof ShareUpdateRequestSchemaV1>;
export type ShareVersionRequestV1 = z.infer<typeof ShareVersionRequestSchemaV1>;
export type ShareSecretReplayResultV1 = z.infer<typeof ShareSecretReplayResultSchemaV1>;
export type SharePublishSuccessV1 = z.infer<typeof SharePublishSuccessSchemaV1>;
export type ShareRotateSuccessV1 = z.infer<typeof ShareRotateSuccessSchemaV1>;
export type ShareUpdateSuccessV1 = z.infer<typeof ShareUpdateSuccessSchemaV1>;
export type ShareErrorV1 = z.infer<typeof ShareErrorSchemaV1>;
export type ShareErrorEnvelopeV1 = z.infer<typeof ShareErrorEnvelopeSchemaV1>;
