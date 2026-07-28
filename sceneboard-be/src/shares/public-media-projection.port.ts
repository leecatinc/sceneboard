import type { PublicMediaResourceV1, RevisionId, BoardId } from '@sceneboard/board-schema';
import type { PoolConnection } from 'mysql2/promise';

import type { RevisionMediaReferenceRowV1 } from '../media/media-reference.types.js';
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
