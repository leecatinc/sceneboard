import { z } from 'zod';

import { ActorContextSchemaV1, type ActorContextV1 } from './actors.js';
import {
  ArtifactManifestSchemaV1,
  ArtifactReferenceSchemaV1,
  ArtifactRuntimeSummarySchemaV1,
} from './artifacts.js';
import {
  EventIdSchemaV1,
  HitlRequestIdSchemaV1,
  IdempotencyKeySchemaV1,
  RequestIdSchemaV1,
  RevisionIdSchemaV1,
  RevisionSummarySchemaV1,
  ShortTextSchemaV1,
  BoardIdSchemaV1,
} from './identifiers.js';
import {
  HitlRequestDefinitionSchemaV1,
  HitlRequestSuccessSchemaV1,
  HitlRespondSuccessSchemaV1,
  HitlResponseSchemaV1,
} from './hitl.js';
import { SceneSchemaV1 } from './scene.js';

const SceneReplaceCommandSchemaV1 = z
  .object({ type: z.literal('scene.replace'), scene: SceneSchemaV1 })
  .strict();
const SceneClearCommandSchemaV1 = z.object({ type: z.literal('scene.clear') }).strict();
const SceneRestoreCommandSchemaV1 = z
  .object({ type: z.literal('scene.restore'), sourceRevisionId: RevisionIdSchemaV1 })
  .strict();
const HitlRequestCommandSchemaV1 = z
  .object({
    type: z.literal('hitl.request'),
    hitlRequestId: HitlRequestIdSchemaV1,
    request: HitlRequestDefinitionSchemaV1,
  })
  .strict();
const HitlRespondCommandSchemaV1 = z
  .object({
    type: z.literal('hitl.respond'),
    hitlRequestId: HitlRequestIdSchemaV1,
    response: HitlResponseSchemaV1,
  })
  .strict();
const ArtifactPublishCommandSchemaV1 = z
  .object({ type: z.literal('artifact.publish'), manifest: ArtifactManifestSchemaV1 })
  .strict();
const ArtifactStopCommandSchemaV1 = z
  .object({
    type: z.literal('artifact.stop'),
    artifact: ArtifactReferenceSchemaV1,
    reason: ShortTextSchemaV1.optional(),
  })
  .strict();

export const BoardMutationCommandSchemaV1 = z.discriminatedUnion('type', [
  SceneReplaceCommandSchemaV1,
  SceneClearCommandSchemaV1,
  SceneRestoreCommandSchemaV1,
  HitlRequestCommandSchemaV1,
  HitlRespondCommandSchemaV1,
  ArtifactPublishCommandSchemaV1,
  ArtifactStopCommandSchemaV1,
]);

const MutationRequestShapeV1 = {
  protocolVersion: z.literal(1),
  requestId: RequestIdSchemaV1,
  idempotencyKey: IdempotencyKeySchemaV1,
  boardId: BoardIdSchemaV1,
  expectedRevisionId: RevisionIdSchemaV1,
  command: BoardMutationCommandSchemaV1,
};

export const MutationRequestSchemaV1 = z.object(MutationRequestShapeV1).strict();
export const MutationEnvelopeSchemaV1 = z
  .object({ ...MutationRequestShapeV1, actor: ActorContextSchemaV1 })
  .strict();

const MutationResultDataSchemaV1 = z.discriminatedUnion('type', [
  z.object({ type: z.literal('scene.replace'), revision: RevisionSummarySchemaV1 }).strict(),
  z.object({ type: z.literal('scene.clear'), revision: RevisionSummarySchemaV1 }).strict(),
  z
    .object({
      type: z.literal('scene.restore'),
      sourceRevisionId: RevisionIdSchemaV1,
      revision: RevisionSummarySchemaV1,
    })
    .strict(),
  z.object({ type: z.literal('hitl.request'), hitl: HitlRequestSuccessSchemaV1 }).strict(),
  z.object({ type: z.literal('hitl.respond'), hitl: HitlRespondSuccessSchemaV1 }).strict(),
  z
    .object({ type: z.literal('artifact.publish'), artifact: ArtifactRuntimeSummarySchemaV1 })
    .strict(),
  z.object({ type: z.literal('artifact.stop'), artifact: ArtifactRuntimeSummarySchemaV1 }).strict(),
]);

export const MutationResultSchemaV1 = z
  .object({
    protocolVersion: z.literal(1),
    type: z.literal('mutation.result'),
    requestId: RequestIdSchemaV1,
    boardId: BoardIdSchemaV1,
    replayed: z.boolean(),
    eventIds: z.array(EventIdSchemaV1),
    result: MutationResultDataSchemaV1,
  })
  .strict()
  .superRefine((result, context) => {
    if (new Set(result.eventIds).size !== result.eventIds.length)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['eventIds'],
        message: 'event IDs must be unique',
      });
  });

export type BoardMutationCommandV1 = z.infer<typeof BoardMutationCommandSchemaV1>;
export type BoardMutationResultDataV1 = z.infer<typeof MutationResultDataSchemaV1>;
export type MutationRequestV1 = z.infer<typeof MutationRequestSchemaV1>;
export type MutationEnvelopeV1 = z.infer<typeof MutationEnvelopeSchemaV1>;
export type MutationResultV1 = z.infer<typeof MutationResultSchemaV1>;
export type MutationFingerprintInputV1 = {
  protocolVersion: 1;
  boardId: MutationEnvelopeV1['boardId'];
  expectedRevisionId: MutationEnvelopeV1['expectedRevisionId'];
  command: BoardMutationCommandV1;
  actor: ActorContextV1;
};
