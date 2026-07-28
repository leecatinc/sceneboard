import { z } from 'zod';

import { ActorReferenceSchemaV1 } from './actors.js';
import { ArtifactRuntimeSummarySchemaV1 } from './artifacts.js';
import { BoardErrorSchema } from './errors.js';
import {
  BoardIdSchemaV1,
  EventIdSchemaV1,
  RevisionIdSchemaV1,
  RevisionOriginTypeSchemaV1,
  RevisionSummarySchemaV1,
  TimestampSchemaV1,
} from './identifiers.js';
import { HitlInteractionSchemaV1 } from './hitl.js';
import { BoardSnapshotSchema } from './snapshots.js';

export const PresenceSummarySchemaV1 = z
  .object({
    principal: ActorReferenceSchemaV1,
    state: z.enum(['online', 'away']),
    lastSeenAt: TimestampSchemaV1,
  })
  .strict();

const BoardEventDataSchemaV1 = z.discriminatedUnion('type', [
  z.object({ type: z.literal('board.snapshot'), snapshot: BoardSnapshotSchema }).strict(),
  z
    .object({
      type: z.literal('board.revision.created'),
      revision: RevisionSummarySchemaV1,
      originType: RevisionOriginTypeSchemaV1,
      sourceRevisionId: RevisionIdSchemaV1.nullable(),
    })
    .strict(),
  z.object({ type: z.literal('hitl.updated'), hitl: HitlInteractionSchemaV1 }).strict(),
  z
    .object({
      type: z.literal('artifact.status.changed'),
      artifact: ArtifactRuntimeSummarySchemaV1,
    })
    .strict(),
  z
    .object({ type: z.literal('presence.updated'), presence: z.array(PresenceSummarySchemaV1) })
    .strict(),
  z
    .object({
      type: z.literal('stream.resync.required'),
      durableHeadRevisionId: RevisionIdSchemaV1,
      lastUsableSequence: z.number().int().safe().min(0),
      reason: z.enum(['gap', 'expired_cursor', 'server_reset']),
    })
    .strict(),
  z.object({ type: z.literal('stream.heartbeat'), sentAt: TimestampSchemaV1 }).strict(),
  z.object({ type: z.literal('stream.error'), error: BoardErrorSchema }).strict(),
]);

export const BoardEventEnvelopeSchemaV1 = z
  .object({
    protocolVersion: z.literal(1),
    type: z.literal('board.event'),
    boardId: BoardIdSchemaV1,
    eventId: EventIdSchemaV1,
    sequence: z.number().int().safe().positive(),
    occurredAt: TimestampSchemaV1,
    revisionId: RevisionIdSchemaV1.nullable(),
    data: BoardEventDataSchemaV1,
  })
  .strict()
  .superRefine((event, context) => {
    const data = event.data;
    if (data.type === 'board.snapshot') {
      if (event.boardId !== data.snapshot.boardId)
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['data', 'snapshot', 'boardId'],
          message: '[INVALID_LAYOUT:reference] snapshot board ID mismatch',
        });
      if (event.revisionId !== data.snapshot.revision.revisionId)
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['revisionId'],
          message: '[INVALID_LAYOUT:reference] snapshot revision mismatch',
        });
      if (event.sequence !== data.snapshot.lastEventSequence)
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['data', 'snapshot', 'lastEventSequence'],
          message: '[INVALID_LAYOUT:reference] snapshot watermark mismatch',
        });
    } else if (data.type === 'board.revision.created') {
      if (event.revisionId !== data.revision.revisionId)
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['revisionId'],
          message: '[INVALID_LAYOUT:reference] revision event mismatch',
        });
      if ((data.originType === 'scene.restore') !== (data.sourceRevisionId !== null))
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['data', 'sourceRevisionId'],
          message: '[INVALID_LAYOUT:reference] restore source mismatch',
        });
    } else {
      if (event.revisionId !== null)
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['revisionId'],
          message: '[INVALID_LAYOUT:reference] control event revision must be null',
        });
      if (data.type === 'stream.resync.required' && data.lastUsableSequence >= event.sequence)
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['data', 'lastUsableSequence'],
          message: '[INVALID_LAYOUT:reference] resync sequence is stale',
        });
      if (data.type === 'stream.heartbeat' && data.sentAt !== event.occurredAt)
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['data', 'sentAt'],
          message: '[INVALID_LAYOUT:reference] heartbeat timestamp mismatch',
        });
      if (data.type === 'presence.updated') {
        const keys = data.presence.map(
          ({ principal }) => `${principal.principalKind}\0${principal.principalId}`,
        );
        for (let index = 1; index < keys.length; index += 1)
          if ((keys[index - 1] ?? '') >= (keys[index] ?? '')) {
            context.addIssue({
              code: z.ZodIssueCode.custom,
              path: ['data', 'presence'],
              message: '[INVALID_LAYOUT:reference] presence must be sorted and unique',
            });
            break;
          }
      }
    }
  });

export type PresenceSummaryV1 = z.infer<typeof PresenceSummarySchemaV1>;
export type BoardEventEnvelopeV1 = z.infer<typeof BoardEventEnvelopeSchemaV1>;
export type BoardEventDataV1 = BoardEventEnvelopeV1['data'];
