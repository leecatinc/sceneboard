import type { PublicMediaResourceV1, RevisionId, BoardId } from '@sceneboard/board-schema';
import type { PoolConnection } from 'mysql2/promise';

import type { RevisionMediaReferenceRowV1 } from '../media/media-reference.types.js';
import { MediaRepository } from '../media/media.repository.js';
import { BoardPersistenceError } from '../common/errors/board-persistence.error.js';
import { PublicShareHttpError } from './public-share.error.js';

export interface PublicMediaProjectionInput {
  boardPk: bigint;
  revisionPk: bigint;
  boardId: BoardId;
  revisionId: RevisionId;
  shareId: string;
  publicationGeneration: number;
  accessGeneration: number;
  contextId: string;
  references: readonly RevisionMediaReferenceRowV1[];
}

export abstract class PublicMediaProjectionPort {
  abstract read(
    connection: PoolConnection,
    input: PublicMediaProjectionInput,
  ): Promise<readonly PublicMediaResourceV1[]>;
}

export class DenyAllPublicMediaProjection extends PublicMediaProjectionPort {
  async read(
    _connection: PoolConnection,
    input: PublicMediaProjectionInput,
  ): Promise<readonly PublicMediaResourceV1[]> {
    if (input.references.length !== 0) throw new PublicShareHttpError(503);
    return [];
  }
}

export class MysqlPublicMediaProjection extends PublicMediaProjectionPort {
  constructor(private readonly media: MediaRepository) {
    super();
  }

  async read(
    connection: PoolConnection,
    input: PublicMediaProjectionInput,
  ): Promise<readonly PublicMediaResourceV1[]> {
    const output: PublicMediaResourceV1[] = [];
    try {
      for (const reference of input.references) {
        const locator = await this.media.findBoardOwnership(
          connection,
          input.boardPk,
          reference.mediaId,
        );
        if (locator === null || locator.status !== 'active') throw new PublicShareHttpError(503);
        const object = await this.media.lockCanonicalObjectMetadata(connection, locator.mediaPk);
        const ownership = await this.media.lockBoardOwnership(
          connection,
          input.boardPk,
          reference.mediaId,
        );
        if (
          object === null ||
          object.state !== 'active' ||
          ownership === null ||
          ownership.status !== 'active' ||
          ownership.mediaPk !== locator.mediaPk ||
          object.mediaPk !== locator.mediaPk
        )
          throw new PublicShareHttpError(503);
        output.push({
          mediaId: reference.mediaId,
          url: `/api/v1/public/shares/${input.shareId}/revisions/${input.revisionId}/g/${input.publicationGeneration}/${input.accessGeneration}/media/${reference.mediaId}?contextId=${input.contextId}`,
          mime: object.mime,
          width: object.width,
          height: object.height,
          etag: `"sha256-${object.sha256.toString('hex')}"`,
        });
      }
      return output;
    } catch (error) {
      if (error instanceof PublicShareHttpError) throw error;
      if (error instanceof BoardPersistenceError) throw new PublicShareHttpError(503);
      throw new PublicShareHttpError(503);
    }
  }
}
