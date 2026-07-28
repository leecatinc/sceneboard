import type { MediaId } from '@sceneboard/board-schema';
import type { PoolConnection } from 'mysql2/promise';

import { BoardContractError } from '../common/errors/app-error.js';
import { invalidMediaReference } from '../common/errors/board-error.factory.js';
import { MediaOwnershipPort } from './media-ownership.port.js';

export class DenyAllMediaOwnershipProvider extends MediaOwnershipPort {
  async assertOwnedByBoard(
    _connection: PoolConnection,
    _boardPk: bigint,
    mediaIds: readonly MediaId[],
  ): Promise<void> {
    if (mediaIds.length > 0) throw new BoardContractError(invalidMediaReference());
  }
}
