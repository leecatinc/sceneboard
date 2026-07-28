import type { PoolConnection } from 'mysql2/promise';

import { encodeArtifactPackageV1 } from '../artifacts/artifact-package.builder.js';
import type { ArtifactRepository } from '../artifacts/artifact.repository.js';
import {
  assertPublicArtifactEntitlement,
  type PublicArtifactEntitlement,
  type PublicResourceEntitlementService,
} from './public-resource-entitlement.js';
import { PublicShareHttpError } from './public-share.error.js';

const packageLength = (
  manifestBytes: number,
  resources: readonly { path: string; byteLength: number }[],
): number =>
  resources.reduce(
    (total, resource) =>
      total + 2 + Buffer.byteLength(resource.path, 'utf8') + 4 + resource.byteLength,
    8 + 4 + manifestBytes + 2,
  );

export class PublicArtifactDeliveryService {
  constructor(
    private readonly entitlements: PublicResourceEntitlementService,
    private readonly artifacts: ArtifactRepository,
  ) {}

  async get(input: {
    shareId: string;
    revisionId: string;
    publicationGeneration: string;
    accessGeneration: string;
    artifactId: string;
    versionId: string;
    contextId: string;
    cookieHeader?: string | undefined;
    rangeHeader?: string | undefined;
  }): Promise<Buffer> {
    return this.entitlements.authorizeArtifact({
      ...input,
      operation: (connection, entitlement) =>
        this.readAuthorized(connection, entitlement, input.rangeHeader),
    });
  }

  private async readAuthorized(
    connection: PoolConnection,
    entitlement: PublicArtifactEntitlement,
    rangeHeader: string | undefined,
  ): Promise<Buffer> {
    assertPublicArtifactEntitlement(entitlement);
    try {
      const reference = {
        artifactId: entitlement.artifactId,
        versionId: entitlement.versionId,
      };
      const metadata = await this.artifacts.readVersion(
        connection,
        entitlement.boardId,
        reference,
        false,
      );
      if (metadata.runtime.status !== 'ready') throw new PublicShareHttpError(404);
      const certifiedLength = packageLength(metadata.manifestBytes.byteLength, metadata.resources);
      if (rangeHeader !== undefined) throw new PublicShareHttpError(416, null, certifiedLength);
      const stored = await this.artifacts.readVersion(
        connection,
        entitlement.boardId,
        reference,
        true,
      );
      if (
        stored.runtime.status !== 'ready' ||
        stored.versionPk !== metadata.versionPk ||
        stored.boardPk !== metadata.boardPk
      )
        throw new PublicShareHttpError(503);
      const bytes = encodeArtifactPackageV1(stored.manifestBytes, stored.resources);
      if (bytes.byteLength !== certifiedLength) throw new PublicShareHttpError(503);
      return bytes;
    } catch (error) {
      if (error instanceof PublicShareHttpError) throw error;
      throw new PublicShareHttpError(503);
    }
  }
}
