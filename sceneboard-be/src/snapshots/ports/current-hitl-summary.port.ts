import type { HitlInteractionV1 } from '@sceneboard/board-schema';
import type { PoolConnection } from 'mysql2/promise';

import type { SnapshotCompositionInputV1 } from '../../revisions/snapshot-composition.service.js';

export abstract class CurrentHitlSummaryPort {
  abstract readAuthorizedAtCut(
    connection: PoolConnection,
    input: SnapshotCompositionInputV1,
  ): Promise<readonly HitlInteractionV1[]>;
}
