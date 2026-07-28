import { z } from 'zod';

import { ActorContextSchemaV1, ActorReferenceSchemaV1, type ActorContextV1 } from './actors.js';
import {
  ArtifactManifestSchemaV1,
  ArtifactReferenceSchemaV1,
  ArtifactRuntimeSummarySchemaV1,
} from './artifacts.js';
import { BoardCapabilitiesSchema } from './capabilities.js';
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
  z.object({ type: z.literal('capabilities.get'), capabilities: BoardCapabilitiesSchema }).strict(),
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
