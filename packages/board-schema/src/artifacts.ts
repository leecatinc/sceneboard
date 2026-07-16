import { z } from 'zod';

import {
  ARTIFACT_REQUEST_CAPABILITIES_V1,
  BOARD_ERROR_CODES_V1,
} from './catalogs.js';
import {
  ArtifactIdSchemaV1,
  ArtifactVersionIdSchemaV1,
  ShortTextSchemaV1,
  TimestampSchemaV1,
} from './identifiers.js';
import {
  MAX_ARTIFACT_RESOURCES,
  MAX_ARTIFACT_RESOURCE_BYTES,
  MAX_ARTIFACT_TOTAL_BYTES,
} from './limits.js';

const ArtifactRequestCapabilitySchemaV1 = z.enum(ARTIFACT_REQUEST_CAPABILITIES_V1);
const BoardErrorCodeSchemaV1 = z.enum(BOARD_ERROR_CODES_V1);

export const isNormalizedArtifactPathV1 = (path: string): boolean =>
  path.length > 0 &&
  !path.startsWith('/') &&
  !path.includes('\\') &&
  !path.includes('\0') &&
  path.split('/').every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');

export const ArtifactPathSchemaV1 = z.string().refine(isNormalizedArtifactPathV1, 'artifact path must be normalized');
export const ArtifactDigestSchemaV1 = z.string().regex(/^[0-9a-f]{64}$/);

export const ArtifactReferenceSchemaV1 = z
  .object({
    artifactId: ArtifactIdSchemaV1,
    versionId: ArtifactVersionIdSchemaV1,
  })
  .strict();

export const ArtifactResourceSchemaV1 = z
  .object({
    path: ArtifactPathSchemaV1,
    mediaType: z.string().regex(/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]{1,127}$/),
    sha256: ArtifactDigestSchemaV1,
    byteLength: z.number().int().safe().min(0).max(MAX_ARTIFACT_RESOURCE_BYTES),
  })
  .strict();

export const ArtifactManifestSchemaV1 = z
  .object({
    protocolVersion: z.literal(1),
    type: z.literal('artifact.manifest'),
    artifact: ArtifactReferenceSchemaV1,
    entryPath: ArtifactPathSchemaV1,
    resources: z.array(ArtifactResourceSchemaV1).min(1).max(MAX_ARTIFACT_RESOURCES),
    requestedCapabilities: z.array(ArtifactRequestCapabilitySchemaV1).max(ARTIFACT_REQUEST_CAPABILITIES_V1.length),
  })
  .strict()
  .superRefine((manifest, context) => {
    const paths = new Set<string>();
    let totalBytes = 0;
    for (let index = 0; index < manifest.resources.length; index += 1) {
      const resource = manifest.resources[index];
      if (!resource) continue;
      if (paths.has(resource.path)) context.addIssue({ code: z.ZodIssueCode.custom, path: ['resources', index, 'path'], message: 'duplicate artifact resource path' });
      paths.add(resource.path);
      totalBytes += resource.byteLength;
    }
    if (!paths.has(manifest.entryPath)) context.addIssue({ code: z.ZodIssueCode.custom, path: ['entryPath'], message: 'entryPath must reference a resource' });
    if (totalBytes > MAX_ARTIFACT_TOTAL_BYTES) context.addIssue({ code: z.ZodIssueCode.custom, path: ['resources'], message: '[LIMIT:maxArtifactTotalBytes] artifact total bytes exceeded' });
    for (let index = 0; index < manifest.requestedCapabilities.length; index += 1) {
      if (index > 0 && (manifest.requestedCapabilities[index - 1] ?? '') >= (manifest.requestedCapabilities[index] ?? '')) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ['requestedCapabilities'], message: 'requestedCapabilities must be sorted and unique' });
        break;
      }
    }
  });

export const ArtifactRuntimeSummarySchemaV1 = z
  .object({
    artifact: ArtifactReferenceSchemaV1,
    status: z.enum(['ready', 'running', 'stopped', 'failed', 'blocked']),
    updatedAt: TimestampSchemaV1,
    failure: z
      .object({ code: BoardErrorCodeSchemaV1, message: ShortTextSchemaV1 })
      .strict()
      .nullable(),
  })
  .strict()
  .superRefine((summary, context) => {
    const requiresFailure = summary.status === 'failed' || summary.status === 'blocked';
    if (requiresFailure !== (summary.failure !== null)) context.addIssue({ code: z.ZodIssueCode.custom, path: ['failure'], message: 'failure must match artifact status' });
  });

export type ArtifactReferenceV1 = z.infer<typeof ArtifactReferenceSchemaV1>;
export type ArtifactResourceV1 = z.infer<typeof ArtifactResourceSchemaV1>;
export type ArtifactManifestV1 = z.infer<typeof ArtifactManifestSchemaV1>;
export type ArtifactRuntimeSummaryV1 = z.infer<typeof ArtifactRuntimeSummarySchemaV1>;
