import { z } from 'zod';

import { ActorReferenceSchemaV1 } from './actors.js';
import { ArtifactRuntimeSummarySchemaV1 } from './artifacts.js';
import { BoardCapabilitiesSchemaV1 } from './capabilities.js';
import {
  BoardIdSchemaV1,
  RevisionIdSchemaV1,
  RevisionOriginTypeSchemaV1,
  RevisionSummarySchemaV1,
} from './identifiers.js';
import { HitlInteractionSchemaV1 } from './hitl.js';
import { collectSceneNodesV1, SceneSchemaV1 } from './scene.js';

export const SnapshotRevisionSchemaV1 = RevisionSummarySchemaV1.extend({
  previousRevisionId: RevisionIdSchemaV1.nullable(),
  originType: RevisionOriginTypeSchemaV1,
  sourceRevisionId: RevisionIdSchemaV1.nullable(),
  actor: ActorReferenceSchemaV1,
}).strict();

const artifactKey = (artifact: { artifactId: string; versionId: string }) =>
  `${artifact.artifactId}\0${artifact.versionId}`;

export const BoardSnapshotSchemaV1 = z
  .object({
    protocolVersion: z.literal(1),
    type: z.literal('board.snapshot'),
    boardId: BoardIdSchemaV1,
    revision: SnapshotRevisionSchemaV1,
    scene: SceneSchemaV1,
    hitl: z.array(HitlInteractionSchemaV1),
    artifacts: z.array(ArtifactRuntimeSummarySchemaV1),
    capabilities: BoardCapabilitiesSchemaV1,
    lastEventSequence: z.number().int().safe().min(0),
  })
  .strict()
  .superRefine((snapshot, context) => {
    if (snapshot.revision.revisionNumber === 1) {
      if (
        snapshot.revision.previousRevisionId !== null ||
        snapshot.revision.originType !== 'board.create' ||
        snapshot.revision.sourceRevisionId !== null
      )
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['revision'],
          message: '[INVALID_LAYOUT] initial revision metadata is invalid',
        });
    } else if (
      snapshot.revision.previousRevisionId === null ||
      snapshot.revision.originType === 'board.create' ||
      (snapshot.revision.originType === 'scene.restore') !==
        (snapshot.revision.sourceRevisionId !== null)
    )
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['revision'],
        message: '[INVALID_LAYOUT] revision lineage is invalid',
      });

    const hitlIds = new Set<string>();
    snapshot.hitl.forEach((interaction, index) => {
      if (hitlIds.has(interaction.hitlRequestId))
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['hitl', index, 'hitlRequestId'],
          message: '[INVALID_LAYOUT] duplicate HITL interaction',
        });
      hitlIds.add(interaction.hitlRequestId);
    });
    const artifactKeys = new Set<string>();
    snapshot.artifacts.forEach((runtime, index) => {
      const key = artifactKey(runtime.artifact);
      if (artifactKeys.has(key))
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['artifacts', index, 'artifact'],
          message: '[INVALID_LAYOUT] duplicate artifact runtime summary',
        });
      artifactKeys.add(key);
    });
    for (const item of collectSceneNodesV1(snapshot.scene.root)) {
      if (item.node.type === 'content.hitl' && !hitlIds.has(item.node.hitlRequestId as string))
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['scene', ...item.path, 'hitlRequestId'],
          message: '[INVALID_LAYOUT] unresolved HITL reference',
        });
      const reference =
        item.node.type === 'content.artifact'
          ? item.node.artifact
          : item.node.type === 'content.image'
            ? (item.node.source as { artifact: { artifactId: string; versionId: string } }).artifact
            : null;
      if (
        reference &&
        !artifactKeys.has(artifactKey(reference as { artifactId: string; versionId: string }))
      )
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [
            'scene',
            ...item.path,
            ...(item.node.type === 'content.image' ? ['source', 'artifact'] : ['artifact']),
          ],
          message: '[INVALID_LAYOUT] unresolved artifact reference',
        });
    }
  });

export type BoardSnapshotV1 = z.infer<typeof BoardSnapshotSchemaV1>;
