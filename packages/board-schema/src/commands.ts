import { z } from 'zod';

import { ActorContextSchemaV1, type ActorContextV1 } from './actors.js';
import {
  ArtifactManifestSchemaV1,
  ArtifactReferenceSchemaV1,
  ArtifactRuntimeSummarySchemaV1,
} from './artifacts.js';
import { BoardDocumentSchemaV2 } from './documents.js';
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
const DocumentReplaceCommandSchemaV2 = z
  .object({ type: z.literal('document.replace'), document: BoardDocumentSchemaV2 })
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
export const BoardMutationCommandSchemaV2 = z.discriminatedUnion('type', [
  SceneReplaceCommandSchemaV1,
  SceneClearCommandSchemaV1,
  SceneRestoreCommandSchemaV1,
  HitlRequestCommandSchemaV1,
  HitlRespondCommandSchemaV1,
  ArtifactPublishCommandSchemaV1,
  ArtifactStopCommandSchemaV1,
  DocumentReplaceCommandSchemaV2,
]);

const MutationRequestShapeV1 = {
  protocolVersion: z.literal(1),
  requestId: RequestIdSchemaV1,
  idempotencyKey: IdempotencyKeySchemaV1,
  boardId: BoardIdSchemaV1,
  expectedRevisionId: RevisionIdSchemaV1,
  command: BoardMutationCommandSchemaV1,
};
const MutationRequestShapeV2 = {
  ...MutationRequestShapeV1,
  command: BoardMutationCommandSchemaV2,
};

export const MutationRequestSchemaV1 = z.object(MutationRequestShapeV1).strict();
export const MutationEnvelopeSchemaV1 = z
  .object({ ...MutationRequestShapeV1, actor: ActorContextSchemaV1 })
  .strict();
export const MutationRequestSchemaV2 = z.object(MutationRequestShapeV2).strict();
export const MutationEnvelopeSchemaV2 = z
  .object({ ...MutationRequestShapeV2, actor: ActorContextSchemaV1 })
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
const DocumentReplaceResultDataSchemaV2 = z
  .object({
    type: z.literal('document.replace'),
    revision: RevisionSummarySchemaV1,
    originType: z.literal('document.replace'),
    sourceRevisionId: z.null(),
    document: BoardDocumentSchemaV2,
  })
  .strict();
const MutationResultDataSchemaV2 = z.discriminatedUnion('type', [
  ...MutationResultDataSchemaV1.options,
  DocumentReplaceResultDataSchemaV2,
]);

const mutationResultSchema = <Result extends z.ZodTypeAny>(result: Result) =>
  z
    .object({
      protocolVersion: z.literal(1),
      type: z.literal('mutation.result'),
      requestId: RequestIdSchemaV1,
      boardId: BoardIdSchemaV1,
      replayed: z.boolean(),
      eventIds: z.array(EventIdSchemaV1),
      result,
    })
    .strict()
    .superRefine((envelope, context) => {
      if (new Set(envelope.eventIds).size !== envelope.eventIds.length)
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['eventIds'],
          message: 'event IDs must be unique',
        });
    });

export const MutationResultSchemaV1 = mutationResultSchema(MutationResultDataSchemaV1);
export const MutationResultSchemaV2 = mutationResultSchema(MutationResultDataSchemaV2);

export type BoardMutationCommandV1 = z.infer<typeof BoardMutationCommandSchemaV1>;
export type BoardMutationCommandV2 = z.infer<typeof BoardMutationCommandSchemaV2>;
export type BoardMutationResultDataV1 = z.infer<typeof MutationResultDataSchemaV1>;
export type BoardMutationResultDataV2 = z.infer<typeof MutationResultDataSchemaV2>;
export type MutationRequestV1 = z.infer<typeof MutationRequestSchemaV1>;
export type MutationRequestV2 = z.infer<typeof MutationRequestSchemaV2>;
export type MutationEnvelopeV1 = z.infer<typeof MutationEnvelopeSchemaV1>;
export type MutationEnvelopeV2 = z.infer<typeof MutationEnvelopeSchemaV2>;
export type MutationResultV1 = z.infer<typeof MutationResultSchemaV1>;
export type MutationResultV2 = z.infer<typeof MutationResultSchemaV2>;
export type MutationFingerprintInputV1 = {
  protocolVersion: 1;
  boardId: MutationEnvelopeV1['boardId'];
  expectedRevisionId: MutationEnvelopeV1['expectedRevisionId'];
  command: BoardMutationCommandV1;
  actor: ActorContextV1;
};
export type MutationFingerprintInputV2 = {
  protocolVersion: 1;
  boardId: MutationEnvelopeV2['boardId'];
  expectedRevisionId: MutationEnvelopeV2['expectedRevisionId'];
  command: BoardMutationCommandV2;
  actor: ActorContextV1;
};
