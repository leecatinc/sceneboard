import type { MediaId } from '@sceneboard/board-schema';
import type { PoolConnection } from 'mysql2/promise';

export abstract class MediaOwnershipPort {
  abstract assertOwnedByBoard(
    connection: PoolConnection,
    boardPk: bigint,
    mediaIds: readonly MediaId[],
  ): Promise<void>;
}

export const MEDIA_OWNERSHIP_PORT = MediaOwnershipPort;
