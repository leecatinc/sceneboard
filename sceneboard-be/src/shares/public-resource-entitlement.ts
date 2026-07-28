import { createHash } from 'node:crypto';

import {
  ArtifactReferenceParserV1,
  GlobalIdStringParserV1,
  MediaIdParserV1,
  PublicContextIdParserV1,
  canonicalizeJsonV1,
  type ArtifactId,
  type ArtifactVersionId,
  type BoardId,
  type MediaId,
  type RevisionId,
} from '@sceneboard/board-schema';
import type { PoolConnection } from 'mysql2/promise';

import type { PublicContextCookieService } from './public-context-cookie.service.js';
import type { PublicContextStore } from './public-context.store.js';
import { PublicShareHttpError } from './public-share.error.js';
import type { PublicShareProjectionRepository } from './public-share-projection.repository.js';
import type { PublicShareResolver } from './public-share.resolver.js';
import type { ShareCookieService } from './share-cookie.service.js';

export type PublicResourceEntitlement =
  | Readonly<{
      kind: 'artifact';
      boardPk: bigint;
      sharePk: bigint;
      revisionPk: bigint;
      shareId: string;
      boardId: BoardId;
      revisionId: RevisionId;
      publicationGeneration: number;
      accessGeneration: number;
      contextId: string;
      artifactId: ArtifactId;
      versionId: ArtifactVersionId;
      referenceDigest: Buffer;
    }>
  | Readonly<{
      kind: 'media';
      boardPk: bigint;
      sharePk: bigint;
      revisionPk: bigint;
      shareId: string;
      boardId: BoardId;
      revisionId: RevisionId;
      publicationGeneration: number;
      accessGeneration: number;
      contextId: string;
      mediaId: MediaId;
      referenceDigest: Buffer;
    }>;

export type PublicArtifactEntitlement = Extract<PublicResourceEntitlement, { kind: 'artifact' }>;
export type PublicMediaEntitlement = Extract<PublicResourceEntitlement, { kind: 'media' }>;

const constructedEntitlements = new WeakSet<object>();

export const assertPublicArtifactEntitlement = (value: PublicArtifactEntitlement): void => {
  if (
    !Object.isFrozen(value) ||
    !constructedEntitlements.has(value) ||
    value.kind !== 'artifact' ||
    value.referenceDigest.byteLength !== 32
  )
    throw new PublicShareHttpError(503);
};

export const assertPublicMediaEntitlement = (value: PublicMediaEntitlement): void => {
  if (
    !Object.isFrozen(value) ||
    !constructedEntitlements.has(value) ||
    value.kind !== 'media' ||
    value.referenceDigest.byteLength !== 32
  )
    throw new PublicShareHttpError(503);
};

const positiveGeneration = (value: string): number => {
  if (!/^[1-9][0-9]{0,15}$/u.test(value)) throw new PublicShareHttpError(400);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new PublicShareHttpError(400);
  return parsed;
};

export class PublicResourceEntitlementService {
  private readonly hostname: string;

  constructor(
    private readonly contexts: PublicContextStore,
    private readonly contextCookies: PublicContextCookieService,
    private readonly shareCookies: ShareCookieService,
    private readonly resolver: PublicShareResolver,
    private readonly projections: PublicShareProjectionRepository,
    browserOrigin: string,
  ) {
    this.hostname = new URL(browserOrigin).hostname;
  }

  async authorizeArtifact<Value>(input: {
    shareId: string;
    revisionId: string;
    publicationGeneration: string;
    accessGeneration: string;
    artifactId: string;
    versionId: string;
    contextId: string;
    cookieHeader?: string | undefined;
    operation: (
      connection: PoolConnection,
      entitlement: PublicArtifactEntitlement,
    ) => Promise<Value>;
  }): Promise<Value> {
    const shareId = GlobalIdStringParserV1.parse(input.shareId);
    const revisionId = GlobalIdStringParserV1.parse(input.revisionId);
    const artifact = ArtifactReferenceParserV1.parse({
      artifactId: input.artifactId,
      versionId: input.versionId,
    });
    const contextId = PublicContextIdParserV1.parse(input.contextId);
    if (!shareId.ok || !revisionId.ok || !artifact.ok || !contextId.ok)
      throw new PublicShareHttpError(400);
    const publicationGeneration = positiveGeneration(input.publicationGeneration);
    const accessGeneration = positiveGeneration(input.accessGeneration);
    const contextFamily = this.contextCookies.inspect(input.cookieHeader, this.hostname);
    if (contextFamily.kind === 'invalid') throw new PublicShareHttpError(400);
    if (contextFamily.kind === 'absent') throw new PublicShareHttpError(404);
    const stored = await this.contexts.read({
      familyDigest: contextFamily.digest,
      contextId: contextId.data.value,
    });
    if (stored === null) throw new PublicShareHttpError(404);
    if (
      stored.publicationGeneration !== publicationGeneration ||
      stored.accessGeneration !== accessGeneration
    )
      throw new PublicShareHttpError(404);
    const shareFamily = this.shareCookies.inspectFamilyHeader(input.cookieHeader, this.hostname);
    return this.resolver.withContext({
      context: stored,
      shareFamily,
      operation: async (resolved) => {
        if (
          resolved.share.shareId !== shareId.data.value ||
          resolved.share.pinnedRevisionId !== revisionId.data.value
        )
          throw new PublicShareHttpError(404);
        const projection = await this.projections.build(resolved, contextId.data.value);
        const projected = projection.artifacts.find(
          (candidate) =>
            candidate.artifactId === artifact.data.value.artifactId &&
            candidate.versionId === artifact.data.value.versionId,
        );
        if (projected === undefined || projected.status !== 'ready')
          throw new PublicShareHttpError(404);
        const digestInput = canonicalizeJsonV1({
          kind: 'artifact',
          contextId: contextId.data.value,
          shareId: resolved.share.shareId,
          boardId: resolved.boardId,
          revisionId: resolved.share.pinnedRevisionId,
          publicationGeneration: resolved.share.publicationGeneration,
          accessGeneration: resolved.share.accessGeneration,
          artifactId: artifact.data.value.artifactId,
          versionId: artifact.data.value.versionId,
        });
        if (!digestInput.ok) throw new PublicShareHttpError(503);
        const entitlement = Object.freeze({
          kind: 'artifact' as const,
          boardPk: resolved.share.boardPk,
          sharePk: resolved.share.sharePk,
          revisionPk: resolved.share.pinnedRevisionPk,
          shareId: resolved.share.shareId,
          boardId: resolved.boardId,
          revisionId: resolved.share.pinnedRevisionId,
          publicationGeneration: resolved.share.publicationGeneration,
          accessGeneration: resolved.share.accessGeneration,
          contextId: contextId.data.value,
          artifactId: artifact.data.value.artifactId,
          versionId: artifact.data.value.versionId,
          referenceDigest: createHash('sha256').update(digestInput.data.canonicalBytes).digest(),
        });
        constructedEntitlements.add(entitlement);
        return input.operation(resolved.connection, entitlement);
      },
    });
  }

  async authorizeMedia<Value>(input: {
    shareId: string;
    revisionId: string;
    publicationGeneration: string;
    accessGeneration: string;
    mediaId: string;
    contextId: string;
    cookieHeader?: string | undefined;
    operation: (connection: PoolConnection, entitlement: PublicMediaEntitlement) => Promise<Value>;
  }): Promise<Value> {
    const shareId = GlobalIdStringParserV1.parse(input.shareId);
    const revisionId = GlobalIdStringParserV1.parse(input.revisionId);
    const mediaId = MediaIdParserV1.parse(input.mediaId);
    const contextId = PublicContextIdParserV1.parse(input.contextId);
    if (!shareId.ok || !revisionId.ok || !mediaId.ok || !contextId.ok)
      throw new PublicShareHttpError(400);
    const publicationGeneration = positiveGeneration(input.publicationGeneration);
    const accessGeneration = positiveGeneration(input.accessGeneration);
    const contextFamily = this.contextCookies.inspect(input.cookieHeader, this.hostname);
    if (contextFamily.kind === 'invalid') throw new PublicShareHttpError(400);
    if (contextFamily.kind === 'absent') throw new PublicShareHttpError(404);
    const stored = await this.contexts.read({
      familyDigest: contextFamily.digest,
      contextId: contextId.data.value,
    });
    if (stored === null) throw new PublicShareHttpError(404);
    if (
      stored.publicationGeneration !== publicationGeneration ||
      stored.accessGeneration !== accessGeneration
    )
      throw new PublicShareHttpError(404);
    const shareFamily = this.shareCookies.inspectFamilyHeader(input.cookieHeader, this.hostname);
    return this.resolver.withContext({
      context: stored,
      shareFamily,
      operation: async (resolved) => {
        if (
          resolved.share.shareId !== shareId.data.value ||
          resolved.share.pinnedRevisionId !== revisionId.data.value
        )
          throw new PublicShareHttpError(404);
        const projection = await this.projections.build(resolved, contextId.data.value);
        const projected = projection.media.find(
          (candidate) => candidate.mediaId === mediaId.data.value,
        );
        if (projected === undefined) throw new PublicShareHttpError(404);
        const digestInput = canonicalizeJsonV1({
          kind: 'media',
          contextId: contextId.data.value,
          shareId: resolved.share.shareId,
          boardId: resolved.boardId,
          revisionId: resolved.share.pinnedRevisionId,
          publicationGeneration: resolved.share.publicationGeneration,
          accessGeneration: resolved.share.accessGeneration,
          mediaId: mediaId.data.value,
        });
        if (!digestInput.ok) throw new PublicShareHttpError(503);
        const entitlement = Object.freeze({
          kind: 'media' as const,
          boardPk: resolved.share.boardPk,
          sharePk: resolved.share.sharePk,
          revisionPk: resolved.share.pinnedRevisionPk,
          shareId: resolved.share.shareId,
          boardId: resolved.boardId,
          revisionId: resolved.share.pinnedRevisionId,
          publicationGeneration: resolved.share.publicationGeneration,
          accessGeneration: resolved.share.accessGeneration,
          contextId: contextId.data.value,
          mediaId: mediaId.data.value,
          referenceDigest: createHash('sha256').update(digestInput.data.canonicalBytes).digest(),
        });
        constructedEntitlements.add(entitlement);
        return input.operation(resolved.connection, entitlement);
      },
    });
  }
}
