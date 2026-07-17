import { z } from 'zod';

import { hasLoneSurrogateV1, scalarLengthV1 } from './json.js';
import { MAX_CODE_CHARS, MAX_TITLE_CHARS } from './limits.js';

const GLOBAL_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const LOCAL_ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export const GlobalIdStringSchemaV1 = z.string().regex(GLOBAL_ID_PATTERN);

const globalId = <Name extends string>(_name: Name) =>
  GlobalIdStringSchemaV1.brand<Name>();

export const BoardIdSchemaV1 = globalId('BoardId');
export const RevisionIdSchemaV1 = globalId('RevisionId');
export const RequestIdSchemaV1 = globalId('RequestId');
export const PrincipalIdSchemaV1 = globalId('PrincipalId');
export const GrantIdSchemaV1 = globalId('GrantId');
export const EventIdSchemaV1 = globalId('EventId');
export const ArtifactIdSchemaV1 = globalId('ArtifactId');
export const ArtifactVersionIdSchemaV1 = globalId('ArtifactVersionId');
export const HitlRequestIdSchemaV1 = globalId('HitlRequestId');
export const NodeIdSchemaV1 = z.string().regex(LOCAL_ID_PATTERN).brand<'NodeId'>();
export const TabIdSchemaV1 = z.string().regex(LOCAL_ID_PATTERN).brand<'TabId'>();
export const LocalFieldIdSchemaV1 = z
  .string()
  .regex(LOCAL_ID_PATTERN)
  .brand<'LocalFieldId'>();
export const IdempotencyKeySchemaV1 = z
  .string()
  .min(16)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/)
  .brand<'IdempotencyKey'>();
export const TimestampSchemaV1 = z
  .string()
  .regex(TIMESTAMP_PATTERN)
  .refine((value) => {
    const instant = Date.parse(value);
    return Number.isFinite(instant) && new Date(instant).toISOString() === value;
  })
  .brand<'TimestampV1'>();

export const createScalarTextSchemaV1 = (minimum: number, maximum: number) =>
  z
    .string()
    .refine((value) => !hasLoneSurrogateV1(value), 'lone surrogate is not allowed')
    .refine((value) => {
      const count = scalarLengthV1(value);
      return count >= minimum && count <= maximum;
    }, `must contain ${minimum}-${maximum} Unicode scalar values`);

export const ShortTextSchemaV1 = z
  .string()
  .refine((value) => !hasLoneSurrogateV1(value), 'lone surrogate is not allowed')
  .refine((value) => scalarLengthV1(value) >= 1, 'must contain at least one Unicode scalar value')
  .refine((value) => scalarLengthV1(value) <= MAX_TITLE_CHARS, '[LIMIT:maxTitleChars] text is too long');
export const ContentTextSchemaV1 = z
  .string()
  .refine((value) => !hasLoneSurrogateV1(value), 'lone surrogate is not allowed')
  .refine((value) => scalarLengthV1(value) <= MAX_CODE_CHARS, '[LIMIT:maxCodeChars] text is too long');

export const RevisionOriginTypeSchemaV1 = z.enum([
  'board.create',
  'scene.replace',
  'scene.clear',
  'scene.restore',
]);

export const RevisionSummarySchemaV1 = z
  .object({
    revisionId: RevisionIdSchemaV1,
    revisionNumber: z.number().int().safe().positive(),
    createdAt: TimestampSchemaV1,
  })
  .strict();

export type BoardId = z.infer<typeof BoardIdSchemaV1>;
export type RevisionId = z.infer<typeof RevisionIdSchemaV1>;
export type RequestId = z.infer<typeof RequestIdSchemaV1>;
export type PrincipalId = z.infer<typeof PrincipalIdSchemaV1>;
export type GrantId = z.infer<typeof GrantIdSchemaV1>;
export type EventId = z.infer<typeof EventIdSchemaV1>;
export type ArtifactId = z.infer<typeof ArtifactIdSchemaV1>;
export type ArtifactVersionId = z.infer<typeof ArtifactVersionIdSchemaV1>;
export type HitlRequestId = z.infer<typeof HitlRequestIdSchemaV1>;
export type NodeId = z.infer<typeof NodeIdSchemaV1>;
export type TabId = z.infer<typeof TabIdSchemaV1>;
export type LocalFieldId = z.infer<typeof LocalFieldIdSchemaV1>;
export type IdempotencyKey = z.infer<typeof IdempotencyKeySchemaV1>;
export type TimestampV1 = z.infer<typeof TimestampSchemaV1>;
export type ShortText = z.infer<typeof ShortTextSchemaV1>;
export type ContentText = z.infer<typeof ContentTextSchemaV1>;
export type RevisionOriginTypeV1 = z.infer<typeof RevisionOriginTypeSchemaV1>;
export type RevisionSummaryV1 = z.infer<typeof RevisionSummarySchemaV1>;
