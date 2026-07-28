import type { ArtifactRuntimeSummaryV1 } from '@sceneboard/board-schema';
import type { PoolConnection } from 'mysql2/promise';

import type { SnapshotCompositionInput } from '../../revisions/snapshot-composition.service.js';

export abstract class CurrentArtifactRuntimeSummaryPort {
  abstract readAuthorizedAtCut(
    connection: PoolConnection,
    input: SnapshotCompositionInput,
  ): Promise<readonly ArtifactRuntimeSummaryV1[]>;
}
