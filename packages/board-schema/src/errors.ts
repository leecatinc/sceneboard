import { z } from 'zod';

import { ArtifactReferenceSchemaV1 } from './artifacts.js';
import {
  ARTIFACT_REQUEST_CAPABILITIES_V1,
  BOARD_MUTATION_COMMAND_TYPES_V1,
  CLIENT_GRANT_CAPABILITIES_V1,
} from './catalogs.js';
import {
  BoardIdSchemaV1,
  HitlRequestIdSchemaV1,
  NodeIdSchemaV1,
  RevisionIdSchemaV1,
  ShortTextSchemaV1,
  TimestampSchemaV1,
} from './identifiers.js';
import { BOARD_LIMITS_V1 } from './limits.js';

const PathSchemaV1 = z.array(z.union([z.string(), z.number().int().min(0)]));
const ErrorBaseShapeV1 = {
  protocolVersion: z.literal(1),
  type: z.literal('board.error'),
  message: ShortTextSchemaV1,
};
const branch = <
  Code extends string,
  Category extends string,
  Retryable extends boolean,
  Status extends number,
  Details extends z.ZodTypeAny,
>(
  code: Code,
  category: Category,
  retryable: Retryable,
  httpStatusHint: Status,
  details: Details,
) =>
  z
    .object({
      ...ErrorBaseShapeV1,
      code: z.literal(code),
      category: z.literal(category),
      retryable: z.literal(retryable),
      httpStatusHint: z.literal(httpStatusHint),
      details,
    })
    .strict();

const MutationReuseDetailsSchemaV1 = z.discriminatedUnion('scope', [
  z
    .object({
      scope: z.literal('board.mutation'),
      boardId: BoardIdSchemaV1,
      operationType: z.enum(BOARD_MUTATION_COMMAND_TYPES_V1),
      reason: z.enum([
        'grant_changed',
        'scopes_changed',
        'expected_revision_changed',
        'payload_changed',
      ]),
    })
    .strict(),
  z
    .object({
      scope: z.literal('board.create'),
      boardId: z.null(),
      operationType: z.literal('board.create'),
      reason: z.enum(['grant_changed', 'scopes_changed', 'title_changed']),
    })
    .strict(),
  z
    .object({
      scope: z.literal('board.archive'),
      boardId: BoardIdSchemaV1,
      operationType: z.literal('board.archive'),
      reason: z.enum(['grant_changed', 'scopes_changed']),
    })
    .strict(),
]);
const LimitKeySchemaV1 = z.enum(
  Object.keys(BOARD_LIMITS_V1) as [
    keyof typeof BOARD_LIMITS_V1,
    ...(keyof typeof BOARD_LIMITS_V1)[],
  ],
);
const AnyCapabilitySchemaV1 = z.union([
  z.enum(CLIENT_GRANT_CAPABILITIES_V1),
  z.enum(ARTIFACT_REQUEST_CAPABILITIES_V1),
]);

export const BoardErrorSchemaV1 = z.discriminatedUnion('code', [
  branch(
    'INVALID_PAYLOAD',
    'validation',
    false,
    400,
    z.object({ path: PathSchemaV1, issue: ShortTextSchemaV1 }).strict(),
  ),
  branch(
    'PROTOCOL_VERSION_MISMATCH',
    'protocol',
    false,
    409,
    z
      .object({
        reason: z.enum(['major', 'schema_revision', 'catalog', 'limit']),
        supportedMajor: z.literal(1),
        receivedMajor: z.number().int().min(0).nullable(),
        field: z.string().nullable(),
      })
      .strict(),
  ),
  branch(
    'UNKNOWN_NODE_TYPE',
    'validation',
    false,
    422,
    z.object({ path: PathSchemaV1, receivedType: z.string() }).strict(),
  ),
  branch(
    'UNKNOWN_COMMAND_TYPE',
    'validation',
    false,
    422,
    z.object({ path: PathSchemaV1, receivedType: z.string() }).strict(),
  ),
  branch(
    'UNKNOWN_OPERATION_TYPE',
    'validation',
    false,
    422,
    z.object({ path: PathSchemaV1, receivedType: z.string() }).strict(),
  ),
  branch(
    'INVALID_LAYOUT',
    'validation',
    false,
    422,
    z
      .object({
        path: PathSchemaV1,
        reason: z.enum(['bounds', 'overlap', 'reference', 'geometry']),
      })
      .strict(),
  ),
  branch(
    'DUPLICATE_NODE_ID',
    'validation',
    false,
    422,
    z
      .object({ nodeId: NodeIdSchemaV1, firstPath: PathSchemaV1, duplicatePath: PathSchemaV1 })
      .strict(),
  ),
  branch(
    'LIMIT_EXCEEDED',
    'validation',
    false,
    422,
    z
      .object({
        limit: LimitKeySchemaV1,
        actual: z.number().finite().min(0),
        maximum: z.number().finite().min(0),
        path: PathSchemaV1,
      })
      .strict(),
  ),
  branch(
    'PAYLOAD_TOO_LARGE',
    'validation',
    false,
    413,
    z
      .object({
        scope: z.enum([
          'envelope',
          'scene',
          'hitl.response',
          'artifact.resource',
          'artifact.total',
          'document',
          'document.page',
          'document.envelope',
        ]),
        actualBytes: z.number().int().safe().min(0),
        maximumBytes: z.number().int().safe().positive(),
      })
      .strict(),
  ),
  branch('UNAUTHENTICATED', 'auth', false, 401, z.null()),
  branch('FORBIDDEN', 'auth', false, 403, z.null()),
  branch(
    'CAPABILITY_DENIED',
    'auth',
    false,
    403,
    z.object({ capability: AnyCapabilitySchemaV1 }).strict(),
  ),
  branch('BOARD_NOT_FOUND', 'not_found', false, 404, z.null()),
  branch(
    'REVISION_NOT_FOUND',
    'not_found',
    false,
    404,
    z.object({ revisionId: RevisionIdSchemaV1 }).strict(),
  ),
  branch(
    'ARTIFACT_NOT_FOUND',
    'not_found',
    false,
    404,
    z.object({ artifact: ArtifactReferenceSchemaV1 }).strict(),
  ),
  branch(
    'HITL_REQUEST_NOT_FOUND',
    'not_found',
    false,
    404,
    z.object({ hitlRequestId: HitlRequestIdSchemaV1 }).strict(),
  ),
  branch(
    'BOARD_ALREADY_ARCHIVED',
    'conflict',
    false,
    409,
    z.object({ boardId: BoardIdSchemaV1, archivedAt: TimestampSchemaV1 }).strict(),
  ),
  branch(
    'REVISION_CONFLICT',
    'conflict',
    false,
    409,
    z
      .object({
        boardId: BoardIdSchemaV1,
        expectedRevisionId: RevisionIdSchemaV1,
        actualRevisionId: RevisionIdSchemaV1,
        actualRevisionNumber: z.number().int().safe().positive(),
        recovery: z.literal('fetch_latest_then_retry'),
      })
      .strict(),
  ),
  branch('IDEMPOTENCY_KEY_REUSED', 'conflict', false, 409, MutationReuseDetailsSchemaV1),
  branch(
    'HITL_REQUEST_ID_CONFLICT',
    'conflict',
    false,
    409,
    z.object({ hitlRequestId: HitlRequestIdSchemaV1 }).strict(),
  ),
  branch(
    'HITL_RESPONSE_CONFLICT',
    'conflict',
    false,
    409,
    z
      .object({
        hitlRequestId: HitlRequestIdSchemaV1,
        state: z.enum(['answered', 'superseded', 'cancelled']),
      })
      .strict(),
  ),
  branch(
    'HITL_REQUEST_EXPIRED',
    'conflict',
    false,
    410,
    z.object({ hitlRequestId: HitlRequestIdSchemaV1, expiredAt: TimestampSchemaV1 }).strict(),
  ),
  branch(
    'RATE_LIMITED',
    'rate_limit',
    true,
    429,
    z.object({ retryAfterSeconds: z.number().finite().positive() }).strict(),
  ),
  branch(
    'SERVICE_UNAVAILABLE',
    'availability',
    true,
    503,
    z.object({ retryAfterSeconds: z.number().finite().positive().nullable() }).strict(),
  ),
  branch('INTERNAL_ERROR', 'internal', false, 500, z.null()),
]);

export type BoardErrorV1 = z.infer<typeof BoardErrorSchemaV1>;
export type RevisionConflictErrorV1 = Extract<BoardErrorV1, { code: 'REVISION_CONFLICT' }>;
export type IdempotencyKeyReusedDetailsV1 = z.infer<typeof MutationReuseDetailsSchemaV1>;

const BoardErrorSchemaV2Only = z.discriminatedUnion('code', [
  branch(
    'DOCUMENT_VERSION_MISMATCH',
    'conflict',
    false,
    409,
    z
      .object({
        headSchemaVersion: z.union([z.literal(1), z.literal(2)]),
        commandSchemaVersion: z.union([z.literal(1), z.literal(2)]),
        commandType: z.enum(['scene.replace', 'scene.clear', 'scene.restore', 'document.replace']),
      })
      .strict(),
  ),
  branch(
    'INVALID_DOCUMENT',
    'validation',
    false,
    422,
    z
      .object({
        path: PathSchemaV1,
        reason: z.enum([
          'page_count',
          'duplicate_page_id',
          'default_page_missing',
          'invalid_display_mode',
          'duplicate_node_id',
          'unresolved_reference',
          'limit',
        ]),
      })
      .strict(),
  ),
]);

export const BoardErrorSchema = z.union([BoardErrorSchemaV1, BoardErrorSchemaV2Only]);
export type BoardError = z.infer<typeof BoardErrorSchema>;
