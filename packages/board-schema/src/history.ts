import { z } from 'zod';

import { RevisionIdSchemaV1 } from './identifiers.js';

const PrintableAscii160SchemaV1 = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[\x20-\x7e]+$/u);

export const RetainedHistoryActorLabelSchemaV1 = z.enum(['self', 'owner', 'editor', 'system']);

export const RetainedHistoryMetadataSchemaV1 = z
  .object({
    protocolVersion: z.literal(1),
    type: z.literal('history.retained-metadata'),
    entries: z
      .array(
        z
          .object({
            revisionId: RevisionIdSchemaV1,
            label: PrintableAscii160SchemaV1,
            actorLabel: RetainedHistoryActorLabelSchemaV1,
            summary: PrintableAscii160SchemaV1,
            schemaVersion: z.enum(['1.0.0', '2.0.0', '3.0.0']),
          })
          .strict(),
      )
      .max(100),
    boundary: z
      .object({
        truncatedBefore: z.boolean(),
        oldestRetainedRevisionId: RevisionIdSchemaV1,
      })
      .strict(),
    navigation: z
      .object({
        revisionId: RevisionIdSchemaV1,
        previous: z
          .union([
            z.object({ kind: z.literal('revision'), revisionId: RevisionIdSchemaV1 }).strict(),
            z.object({ kind: z.literal('truncated') }).strict(),
          ])
          .nullable(),
        nextRevisionId: RevisionIdSchemaV1.nullable(),
        latestRevisionId: RevisionIdSchemaV1,
      })
      .strict()
      .nullable(),
  })
  .strict();

export type RetainedHistoryActorLabelV1 = z.infer<typeof RetainedHistoryActorLabelSchemaV1>;
export type RetainedHistoryMetadataV1 = z.infer<typeof RetainedHistoryMetadataSchemaV1>;
