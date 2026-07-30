import { z } from 'zod';

import { BoardDocumentSchemaV2, BoardDocumentSchemaV3 } from './documents.js';
import {
  ArtifactIdSchemaV1,
  ArtifactVersionIdSchemaV1,
  BoardIdSchemaV1,
  GlobalIdStringSchemaV1,
  MediaIdSchemaV1,
  RevisionIdSchemaV1,
  ShortTextSchemaV1,
  TimestampSchemaV1,
} from './identifiers.js';
import { MAX_MEDIA_PIXELS, MAX_MEDIA_REFERENCES } from './limits.js';
import { SharePasswordAdmissionRequestSchemaV1 } from './shares.js';

const canonicalBase64Url32 = (value: string): boolean => {
  if (!/^[A-Za-z0-9_-]{43}$/u.test(value)) return false;
  try {
    const decoded = atob(`${value.replaceAll('-', '+').replaceAll('_', '/')}=`);
    if (decoded.length !== 32) return false;
    return btoa(decoded).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '') === value;
  } catch {
    return false;
  }
};

export const PublicShareTokenSchemaV1 = z
  .string()
  .refine(canonicalBase64Url32, 'share token must be canonical unpadded base64url');
export const PublicContextIdSchemaV1 = z
  .string()
  .refine(canonicalBase64Url32, 'context ID must be canonical unpadded base64url');
export const ShareCsrfTokenSchemaV1 = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[\x21-\x7e]+$/u);

const PUBLIC_ARTIFACT_PATH =
  /^\/api\/v1\/public\/shares\/[A-Za-z0-9_-]{1,128}\/revisions\/[A-Za-z0-9_-]{1,128}\/g\/[1-9][0-9]{0,15}\/[1-9][0-9]{0,15}\/artifacts\/[A-Za-z0-9_-]{1,128}\/versions\/[A-Za-z0-9_-]{1,128}\/package\?contextId=[A-Za-z0-9_-]{43}$/u;
const PUBLIC_MEDIA_PATH =
  /^\/api\/v1\/public\/shares\/[A-Za-z0-9_-]{1,128}\/revisions\/[A-Za-z0-9_-]{1,128}\/g\/[1-9][0-9]{0,15}\/[1-9][0-9]{0,15}\/media\/[A-Za-z0-9_-]{1,128}\?contextId=[A-Za-z0-9_-]{43}$/u;

export const PublicRelativeUrlSchemaV1 = z
  .string()
  .max(2_048)
  .refine(
    (value) =>
      /^[\x21-\x7e]+$/u.test(value) &&
      !value.includes('%') &&
      (PUBLIC_ARTIFACT_PATH.test(value) || PUBLIC_MEDIA_PATH.test(value)),
    'public resource URL must use an exact relative route',
  );

export const QuotedSha256EtagSchemaV1 = z.string().regex(/^"sha256-[0-9a-f]{64}"$/u);

export const PublicShareContextSchemaV1 = z
  .object({
    contextId: PublicContextIdSchemaV1,
    validUntil: TimestampSchemaV1,
  })
  .strict();

const PublicArtifactIdentityShapeV1 = {
  artifactId: ArtifactIdSchemaV1,
  versionId: ArtifactVersionIdSchemaV1,
};

export const PublicArtifactSummarySchemaV1 = z.union([
  z
    .object({
      ...PublicArtifactIdentityShapeV1,
      status: z.literal('ready'),
      packageUrl: PublicRelativeUrlSchemaV1,
    })
    .strict(),
  z
    .object({
      ...PublicArtifactIdentityShapeV1,
      status: z.enum(['running', 'stopped', 'failed', 'blocked']),
      packageUrl: z.null(),
    })
    .strict(),
]);

export const PublicMediaResourceSchemaV1 = z
  .object({
    mediaId: MediaIdSchemaV1,
    url: PublicRelativeUrlSchemaV1,
    mime: z.enum(['image/png', 'image/jpeg', 'image/webp']),
    width: z.number().int().safe().positive(),
    height: z.number().int().safe().positive(),
    etag: QuotedSha256EtagSchemaV1,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.width * value.height > MAX_MEDIA_PIXELS)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['width'],
        message: 'media pixel limit exceeded',
      });
  });

export const PublicBoardProjectionSchemaV1 = z
  .object({
    shareId: GlobalIdStringSchemaV1,
    boardId: BoardIdSchemaV1,
    revisionId: RevisionIdSchemaV1,
    publicationGeneration: z.number().int().safe().positive(),
    accessGeneration: z.number().int().safe().positive(),
    title: ShortTextSchemaV1,
    document: z.union([BoardDocumentSchemaV2, BoardDocumentSchemaV3]),
    artifacts: z.array(PublicArtifactSummarySchemaV1).max(MAX_MEDIA_REFERENCES),
    media: z.array(PublicMediaResourceSchemaV1).max(MAX_MEDIA_REFERENCES),
  })
  .strict()
  .superRefine((projection, context) => {
    const artifactIds = new Set<string>();
    projection.artifacts.forEach((artifact, index) => {
      const key = `${artifact.artifactId}\0${artifact.versionId}`;
      if (artifactIds.has(key))
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['artifacts', index],
          message: 'duplicate public artifact',
        });
      artifactIds.add(key);
    });
    const mediaIds = new Set<string>();
    projection.media.forEach((media, index) => {
      if (mediaIds.has(media.mediaId))
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['media', index],
          message: 'duplicate public media',
        });
      mediaIds.add(media.mediaId);
    });
  });

const expectedArtifactUrl = (
  projection: z.infer<typeof PublicBoardProjectionSchemaV1>,
  contextId: string,
  artifact: z.infer<typeof PublicArtifactSummarySchemaV1>,
): string =>
  `/api/v1/public/shares/${projection.shareId}/revisions/${projection.revisionId}/g/${projection.publicationGeneration}/${projection.accessGeneration}/artifacts/${artifact.artifactId}/versions/${artifact.versionId}/package?contextId=${contextId}`;

const expectedMediaUrl = (
  projection: z.infer<typeof PublicBoardProjectionSchemaV1>,
  contextId: string,
  mediaId: string,
): string =>
  `/api/v1/public/shares/${projection.shareId}/revisions/${projection.revisionId}/g/${projection.publicationGeneration}/${projection.accessGeneration}/media/${mediaId}?contextId=${contextId}`;

export const PublicShareStateSchemaV1 = z
  .union([
    z
      .object({
        state: z.literal('ready'),
        projection: PublicBoardProjectionSchemaV1,
        context: PublicShareContextSchemaV1,
      })
      .strict(),
    z
      .object({
        state: z.literal('password-required'),
        csrfToken: ShareCsrfTokenSchemaV1,
      })
      .strict(),
    z.object({ state: z.literal('unavailable') }).strict(),
    z
      .object({
        state: z.literal('rate-limited'),
        retryAfterSeconds: z.number().int().min(1).max(900),
      })
      .strict(),
  ])
  .superRefine((state, context) => {
    if (state.state !== 'ready') return;
    state.projection.artifacts.forEach((artifact, index) => {
      if (
        artifact.status === 'ready' &&
        artifact.packageUrl !==
          expectedArtifactUrl(state.projection, state.context.contextId, artifact)
      )
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['projection', 'artifacts', index, 'packageUrl'],
          message: 'artifact URL does not match the projection context',
        });
    });
    state.projection.media.forEach((media, index) => {
      if (media.url !== expectedMediaUrl(state.projection, state.context.contextId, media.mediaId))
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['projection', 'media', index, 'url'],
          message: 'media URL does not match the projection context',
        });
    });
  });

export const PublicSharePasswordAdmissionSchemaV1 = SharePasswordAdmissionRequestSchemaV1;

export type PublicShareTokenV1 = z.infer<typeof PublicShareTokenSchemaV1>;
export type PublicContextIdV1 = z.infer<typeof PublicContextIdSchemaV1>;
export type PublicRelativeUrlV1 = z.infer<typeof PublicRelativeUrlSchemaV1>;
export type QuotedSha256EtagV1 = z.infer<typeof QuotedSha256EtagSchemaV1>;
export type PublicShareContextV1 = z.infer<typeof PublicShareContextSchemaV1>;
export type PublicArtifactSummaryV1 = z.infer<typeof PublicArtifactSummarySchemaV1>;
export type PublicMediaResourceV1 = z.infer<typeof PublicMediaResourceSchemaV1>;
export type PublicBoardProjectionV1 = z.infer<typeof PublicBoardProjectionSchemaV1>;
export type PublicShareStateV1 = z.infer<typeof PublicShareStateSchemaV1>;
