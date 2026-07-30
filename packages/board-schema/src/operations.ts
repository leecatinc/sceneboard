import { z } from 'zod';

import { ActorContextSchemaV1, ActorReferenceSchemaV1, type ActorContextV1 } from './actors.js';
import {
  ArtifactManifestSchemaV1,
  ArtifactReferenceSchemaV1,
  ArtifactRuntimeSummarySchemaV1,
} from './artifacts.js';
import { BoardCapabilitiesSchema, BoardSessionAccessSchemaV1 } from './capabilities.js';
import {
  BOARD_AUTHORIZATION_CAPABILITIES_V1,
  BOARD_AUTHORIZATION_OPERATION_TYPES_V1,
  BOARD_AUTHORIZATION_SURFACES_V1,
  type BoardAuthorizationCapabilityV1,
  type BoardAuthorizationOperationTypeV1,
  type BoardAuthorizationSurfaceV1,
  type BoardMembershipRoleV1,
} from './catalogs.js';
import {
  BoardIdSchemaV1,
  HitlRequestIdSchemaV1,
  IdempotencyKeySchemaV1,
  RequestIdSchemaV1,
  RevisionIdSchemaV1,
  RevisionOriginTypeSchemaV1,
  RevisionSummarySchemaV1,
  ShortTextSchemaV1,
  TimestampSchemaV1,
} from './identifiers.js';
import { HitlInteractionSchemaV1 } from './hitl.js';
import { MAX_HITL_WAIT_MS, MAX_PAGE_CURSOR_CHARS, MAX_PAGE_SIZE } from './limits.js';
import { BoardSnapshotSchema } from './snapshots.js';

export type BoardOperationAuthorizationPolicyV1 = {
  operation: BoardAuthorizationOperationTypeV1;
  surfaces: readonly BoardAuthorizationSurfaceV1[];
  requiredCapabilities: readonly BoardAuthorizationCapabilityV1[];
  roles: Readonly<Record<BoardMembershipRoleV1, boolean>>;
  viewerResourceScope: 'none' | 'current_head' | 'all';
  runtimeOwner: string;
};

const policy = (
  operation: BoardAuthorizationOperationTypeV1,
  surfaces: readonly BoardAuthorizationSurfaceV1[],
  requiredCapabilities: readonly BoardAuthorizationCapabilityV1[],
  roles: Readonly<Record<BoardMembershipRoleV1, boolean>>,
  runtimeOwner: string,
  viewerResourceScope: BoardOperationAuthorizationPolicyV1['viewerResourceScope'] = 'none',
): BoardOperationAuthorizationPolicyV1 =>
  Object.freeze({
    operation,
    surfaces: Object.freeze([...surfaces]),
    requiredCapabilities: Object.freeze([...requiredCapabilities]),
    roles: Object.freeze({ ...roles }),
    viewerResourceScope,
    runtimeOwner,
  });

const allRoles = Object.freeze({ owner: true, editor: true, viewer: true });
const editors = Object.freeze({ owner: true, editor: true, viewer: false });
const owners = Object.freeze({ owner: true, editor: false, viewer: false });
const account = Object.freeze({ owner: false, editor: false, viewer: false });

export const BOARD_OPERATION_AUTHORIZATION_MATRIX_V1 = Object.freeze([
  policy('board.list', ['browser', 'mcp', 'account_api_key'], ['board.read'], allRoles, 'I-27'),
  policy(
    'board.get',
    ['browser', 'mcp', 'account_api_key'],
    ['board.read'],
    allRoles,
    'I-27',
    'all',
  ),
  policy(
    'capabilities.get',
    ['browser', 'mcp', 'account_api_key'],
    ['board.read'],
    allRoles,
    'I-27',
    'all',
  ),
  policy('artifact.get', ['browser', 'mcp'], ['board.read'], allRoles, 'I-27', 'current_head'),
  policy('hitl.read', ['browser', 'mcp'], ['board.read'], allRoles, 'I-27', 'current_head'),
  policy(
    'history.list',
    ['browser', 'mcp', 'account_api_key'],
    ['board.history.read'],
    editors,
    'I-27',
  ),
  policy(
    'history.get',
    ['browser', 'mcp', 'account_api_key'],
    ['board.history.read'],
    editors,
    'I-27',
  ),
  policy(
    'board.create',
    ['browser', 'mcp', 'account_api_key'],
    ['account.board.create'],
    account,
    'I-27',
  ),
  policy('board.rename', ['browser', 'account_api_key'], ['board.write'], editors, 'I-27'),
  policy(
    'document.replace',
    ['browser', 'mcp', 'account_api_key'],
    ['board.write'],
    editors,
    'I-19',
  ),
  policy('page.add', ['browser', 'mcp'], ['board.write'], editors, 'I-19'),
  policy('page.update', ['browser', 'mcp'], ['board.write'], editors, 'I-19'),
  policy('page.remove', ['browser', 'mcp'], ['board.write'], editors, 'I-19'),
  policy('page.reorder', ['browser', 'mcp'], ['board.write'], editors, 'I-19'),
  policy('page.default.set', ['browser', 'mcp'], ['board.write'], editors, 'I-19'),
  policy('scene.replace', ['browser', 'mcp', 'account_api_key'], ['board.write'], editors, 'I-27'),
  policy('scene.clear', ['browser', 'mcp', 'account_api_key'], ['board.write'], editors, 'I-27'),
  policy(
    'scene.restore',
    ['browser', 'mcp', 'account_api_key'],
    ['board.history.read', 'board.write'],
    editors,
    'I-27',
  ),
  policy('hitl.request', ['browser', 'mcp'], ['board.hitl.request'], editors, 'I-27'),
  policy('hitl.respond', ['browser', 'mcp'], ['board.hitl.respond'], editors, 'I-27'),
  policy('artifact.publish', ['browser', 'mcp'], ['artifact.publish'], editors, 'I-27'),
  policy('artifact.stop', ['browser', 'mcp'], ['artifact.control'], editors, 'I-27'),
  policy('connection.create', ['browser'], ['connection.manage.own'], editors, 'existing'),
  policy('connection.update', ['browser'], ['connection.manage.own'], editors, 'existing'),
  policy('connection.revoke', ['browser'], ['connection.manage.own'], editors, 'existing'),
  policy('board.archive', ['browser', 'mcp', 'account_api_key'], ['board.admin'], owners, 'I-27'),
  policy('board.delete', ['browser'], ['board.admin'], owners, 'I-27'),
  policy('membership.list', ['browser'], ['board.members.manage'], owners, 'I-28'),
  policy('membership.invite', ['browser'], ['board.members.manage'], owners, 'I-28'),
  policy('membership.role.update', ['browser'], ['board.members.manage'], owners, 'I-28'),
  policy('membership.remove', ['browser'], ['board.members.manage'], owners, 'I-28'),
  policy('ownership.transfer', ['browser'], ['board.members.manage'], owners, 'I-28'),
  policy('share.list', ['browser'], ['board.share.manage'], owners, 'I-29'),
  policy('share.publish', ['browser'], ['board.share.manage'], owners, 'I-29'),
  policy('share.update', ['browser'], ['board.share.manage'], owners, 'I-29'),
  policy('share.rotate', ['browser'], ['board.share.manage'], owners, 'I-29'),
  policy('share.revoke', ['browser'], ['board.share.manage'], owners, 'I-29'),
  policy('share.password.enable', ['browser'], ['board.share.manage'], owners, 'I-30'),
  policy('share.password.regenerate', ['browser'], ['board.share.manage'], owners, 'I-30'),
  policy('share.password.disable', ['browser'], ['board.share.manage'], owners, 'I-30'),
  policy('media.upload', ['browser', 'mcp'], ['board.media.write'], editors, 'I-36/I-40'),
  policy('analytics.report.get', ['browser'], ['board.analytics.read'], owners, 'I-42'),
  policy('export.render', ['browser', 'account_api_key'], ['export.read'], owners, 'I-50', 'all'),
] satisfies readonly BoardOperationAuthorizationPolicyV1[]);

export const BoardOperationAuthorizationPolicySchemaV1 = z
  .object({
    operation: z.enum(BOARD_AUTHORIZATION_OPERATION_TYPES_V1),
    surfaces: z
      .array(z.enum(BOARD_AUTHORIZATION_SURFACES_V1))
      .min(1)
      .superRefine((values, context) => {
        if (new Set(values).size !== values.length)
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'authorization surfaces must be unique',
          });
      }),
    requiredCapabilities: z
      .array(z.enum(BOARD_AUTHORIZATION_CAPABILITIES_V1))
      .min(1)
      .superRefine((values, context) => {
        if (new Set(values).size !== values.length)
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'authorization capabilities must be unique',
          });
      }),
    roles: z
      .object({
        owner: z.boolean(),
        editor: z.boolean(),
        viewer: z.boolean(),
      })
      .strict(),
    viewerResourceScope: z.enum(['none', 'current_head', 'all']),
    runtimeOwner: z.string().min(1).max(64),
  })
  .strict();

export const BoardOperationAuthorizationMatrixSchemaV1 = z
  .array(BoardOperationAuthorizationPolicySchemaV1)
  .length(BOARD_AUTHORIZATION_OPERATION_TYPES_V1.length)
  .superRefine((rows, context) => {
    for (const [index, operation] of BOARD_AUTHORIZATION_OPERATION_TYPES_V1.entries()) {
      const row = rows[index];
      const expected = BOARD_OPERATION_AUTHORIZATION_MATRIX_V1[index];
      if (row?.operation !== operation)
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index, 'operation'],
          message: 'authorization matrix must exactly match operation catalog order',
        });
      if (
        row !== undefined &&
        expected !== undefined &&
        JSON.stringify(row) !== JSON.stringify(expected)
      )
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index],
          message: 'authorization matrix row must exactly match the shared policy',
        });
    }
  });

export const PageCursorSchemaV1 = z
  .string()
  .min(1)
  .max(MAX_PAGE_CURSOR_CHARS)
  .regex(/^[A-Za-z0-9_-]+$/)
  .brand<'PageCursorV1'>();
export const BoardSummarySchemaV1 = z
  .object({
    boardId: BoardIdSchemaV1,
    title: ShortTextSchemaV1,
    createdAt: TimestampSchemaV1,
    updatedAt: TimestampSchemaV1,
    archivedAt: TimestampSchemaV1.nullable(),
    headRevision: RevisionSummarySchemaV1,
  })
  .strict();
export const HistoryEntrySchemaV1 = z
  .object({
    revision: RevisionSummarySchemaV1,
    previousRevisionId: RevisionIdSchemaV1.nullable(),
    originType: RevisionOriginTypeSchemaV1,
    sourceRevisionId: RevisionIdSchemaV1.nullable(),
    actor: ActorReferenceSchemaV1,
  })
  .strict();

const requests = [
  z
    .object({
      protocolVersion: z.literal(1),
      requestId: RequestIdSchemaV1,
      type: z.literal('board.list'),
      cursor: PageCursorSchemaV1.nullable(),
      limit: z.number().int().min(1).max(MAX_PAGE_SIZE),
      includeArchived: z.boolean(),
    })
    .strict(),
  z
    .object({
      protocolVersion: z.literal(1),
      requestId: RequestIdSchemaV1,
      type: z.literal('board.get'),
      boardId: BoardIdSchemaV1,
    })
    .strict(),
  z
    .object({
      protocolVersion: z.literal(1),
      requestId: RequestIdSchemaV1,
      type: z.literal('board.create'),
      idempotencyKey: IdempotencyKeySchemaV1,
      title: ShortTextSchemaV1,
    })
    .strict(),
  z
    .object({
      protocolVersion: z.literal(1),
      requestId: RequestIdSchemaV1,
      type: z.literal('board.archive'),
      idempotencyKey: IdempotencyKeySchemaV1,
      boardId: BoardIdSchemaV1,
      confirm: z.literal(true),
    })
    .strict(),
  z
    .object({
      protocolVersion: z.literal(1),
      requestId: RequestIdSchemaV1,
      type: z.literal('capabilities.get'),
      boardId: BoardIdSchemaV1,
    })
    .strict(),
  z
    .object({
      protocolVersion: z.literal(1),
      requestId: RequestIdSchemaV1,
      type: z.literal('history.list'),
      boardId: BoardIdSchemaV1,
      cursor: PageCursorSchemaV1.nullable(),
      limit: z.number().int().min(1).max(MAX_PAGE_SIZE),
    })
    .strict(),
  z
    .object({
      protocolVersion: z.literal(1),
      requestId: RequestIdSchemaV1,
      type: z.literal('history.get'),
      boardId: BoardIdSchemaV1,
      revisionId: RevisionIdSchemaV1,
    })
    .strict(),
  z
    .object({
      protocolVersion: z.literal(1),
      requestId: RequestIdSchemaV1,
      type: z.literal('artifact.get'),
      boardId: BoardIdSchemaV1,
      artifact: ArtifactReferenceSchemaV1,
    })
    .strict(),
  z
    .object({
      protocolVersion: z.literal(1),
      requestId: RequestIdSchemaV1,
      type: z.literal('hitl.read'),
      boardId: BoardIdSchemaV1,
      hitlRequestId: HitlRequestIdSchemaV1,
      wait: z
        .object({
          afterStateUpdatedAt: TimestampSchemaV1,
          timeoutMs: z.number().int().min(0).max(MAX_HITL_WAIT_MS),
        })
        .strict()
        .nullable(),
    })
    .strict(),
] as const;
export const BoardOperationRequestSchemaV1 = z.discriminatedUnion('type', [...requests] as [
  z.ZodDiscriminatedUnionOption<'type'>,
  ...z.ZodDiscriminatedUnionOption<'type'>[],
]);
export const BoardOperationEnvelopeSchemaV1 = z
  .object({
    protocolVersion: z.literal(1),
    type: z.literal('board.operation.envelope'),
    request: BoardOperationRequestSchemaV1,
    actor: ActorContextSchemaV1,
  })
  .strict();

const results = [
  z
    .object({
      type: z.literal('board.list'),
      boards: z.array(BoardSummarySchemaV1).max(MAX_PAGE_SIZE),
      nextCursor: PageCursorSchemaV1.nullable(),
    })
    .strict(),
  z
    .object({
      type: z.literal('board.get'),
      board: BoardSummarySchemaV1,
      snapshot: BoardSnapshotSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('board.create'),
      board: BoardSummarySchemaV1,
      snapshot: BoardSnapshotSchema,
    })
    .strict(),
  z.object({ type: z.literal('board.archive'), board: BoardSummarySchemaV1 }).strict(),
  z
    .object({
      type: z.literal('capabilities.get'),
      capabilities: BoardCapabilitiesSchema,
      sessionAccess: BoardSessionAccessSchemaV1,
    })
    .strict(),
  z
    .object({
      type: z.literal('history.list'),
      entries: z.array(HistoryEntrySchemaV1).max(MAX_PAGE_SIZE),
      nextCursor: PageCursorSchemaV1.nullable(),
    })
    .strict(),
  z
    .object({
      type: z.literal('history.get'),
      entry: HistoryEntrySchemaV1,
      snapshot: BoardSnapshotSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('artifact.get'),
      manifest: ArtifactManifestSchemaV1,
      runtime: ArtifactRuntimeSummarySchemaV1,
    })
    .strict(),
  z
    .object({ type: z.literal('hitl.read'), changed: z.boolean(), hitl: HitlInteractionSchemaV1 })
    .strict(),
] as const;
export const BoardOperationResultDataSchemaV1 = z.discriminatedUnion('type', [...results] as [
  z.ZodDiscriminatedUnionOption<'type'>,
  ...z.ZodDiscriminatedUnionOption<'type'>[],
]);
export const BoardOperationResultSchemaV1 = z
  .object({
    protocolVersion: z.literal(1),
    type: z.literal('board.operation.result'),
    requestId: RequestIdSchemaV1,
    replayed: z.boolean(),
    result: BoardOperationResultDataSchemaV1,
  })
  .strict()
  .superRefine((envelope, context) => {
    const result = envelope.result;
    if (result.type !== 'board.create' && result.type !== 'board.archive' && envelope.replayed)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['replayed'],
        message: 'read operation results cannot be replayed',
      });
    if (result.type === 'board.get' || result.type === 'board.create') {
      if (
        result.board.boardId !== result.snapshot.boardId ||
        result.board.headRevision.revisionId !== result.snapshot.revision.revisionId
      )
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['result', 'snapshot'],
          message: '[INVALID_LAYOUT] board and snapshot do not correlate',
        });
      if (
        result.type === 'board.create' &&
        (result.snapshot.revision.revisionNumber !== 1 ||
          ('scene' in result.snapshot
            ? result.snapshot.scene.root !== null
            : result.snapshot.document.pages.some(
                (page: { scene: { root: unknown } }) => page.scene.root !== null,
              )))
      )
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['result', 'snapshot'],
          message: '[INVALID_LAYOUT] create snapshot must be initial empty head',
        });
    } else if (
      result.type === 'history.get' &&
      result.entry.revision.revisionId !== result.snapshot.revision.revisionId
    )
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['result', 'snapshot', 'revision', 'revisionId'],
        message: '[INVALID_LAYOUT] history revision does not correlate',
      });
    else if (result.type === 'artifact.get') {
      const expected = `${result.manifest.artifact.artifactId}\0${result.manifest.artifact.versionId}`;
      const actual = `${result.runtime.artifact.artifactId}\0${result.runtime.artifact.versionId}`;
      if (expected !== actual)
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['result', 'runtime', 'artifact'],
          message: '[INVALID_LAYOUT] artifact result does not correlate',
        });
    }
  });

export type BoardOperationRequestV1 = z.infer<typeof BoardOperationRequestSchemaV1>;
export type BoardOperationEnvelopeV1 = z.infer<typeof BoardOperationEnvelopeSchemaV1>;
export type BoardOperationResultDataV1 = z.infer<typeof BoardOperationResultDataSchemaV1>;
export type BoardOperationResultV1 = z.infer<typeof BoardOperationResultSchemaV1>;
export type BoardSummaryV1 = z.infer<typeof BoardSummarySchemaV1>;
export type HistoryEntryV1 = z.infer<typeof HistoryEntrySchemaV1>;
export type PageCursorV1 = z.infer<typeof PageCursorSchemaV1>;
type BoardCreateRequestV1 = z.infer<(typeof requests)[2]>;
type BoardArchiveRequestV1 = z.infer<(typeof requests)[3]>;
export type BoardLifecycleIdempotencyEnvelopeV1 = {
  protocolVersion: 1;
  type: 'board.operation.envelope';
  request: BoardCreateRequestV1 | BoardArchiveRequestV1;
  actor: ActorContextV1;
};
export type BoardOperationFingerprintInputV1 =
  | { protocolVersion: 1; operationType: 'board.create'; title: string; actor: ActorContextV1 }
  | {
      protocolVersion: 1;
      operationType: 'board.archive';
      boardId: z.infer<typeof BoardIdSchemaV1>;
      confirm: true;
      actor: ActorContextV1;
    };
