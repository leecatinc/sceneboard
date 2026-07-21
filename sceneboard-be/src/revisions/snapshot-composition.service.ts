import {
  BoardSnapshotParserV1,
  type ActorContextV1,
  type BoardCapabilitiesV1,
  type BoardId,
  type BoardSnapshotV1,
  type RevisionSummaryV1,
  type SceneV1,
} from '@sceneboard/board-schema';
import type { PoolConnection } from 'mysql2/promise';

import { BoardPersistenceError } from '../common/errors/board-persistence.error.js';
import type { CurrentArtifactRuntimeSummaryPort } from '../snapshots/ports/current-artifact-runtime-summary.port.js';
import type { CurrentHitlSummaryPort } from '../snapshots/ports/current-hitl-summary.port.js';

export interface SnapshotCompositionInputV1 {
  actor: ActorContextV1;
  boardId: BoardId;
  revision: RevisionSummaryV1 & {
    previousRevisionId: BoardSnapshotV1['revision']['previousRevisionId'];
    originType: BoardSnapshotV1['revision']['originType'];
    sourceRevisionId: BoardSnapshotV1['revision']['sourceRevisionId'];
    actor: BoardSnapshotV1['revision']['actor'];
  };
  scene: SceneV1;
  lastEventSequence: number;
}

export interface CurrentBoardCapabilitiesPort {
  readAuthorizedAtCut(
    connection: PoolConnection,
    input: Pick<SnapshotCompositionInputV1, 'actor' | 'boardId' | 'lastEventSequence'>,
  ): Promise<BoardCapabilitiesV1>;
}

export class SnapshotCompositionService {
  constructor(
    private readonly hitl: CurrentHitlSummaryPort,
    private readonly artifacts: CurrentArtifactRuntimeSummaryPort,
    private readonly capabilities: CurrentBoardCapabilitiesPort,
  ) {}

  async compose(
    connection: PoolConnection,
    input: SnapshotCompositionInputV1,
  ): Promise<BoardSnapshotV1> {
    const hitl = await this.hitl.readAuthorizedAtCut(connection, input);
    const artifacts = await this.artifacts.readAuthorizedAtCut(connection, input);
    const capabilities = await this.capabilities.readAuthorizedAtCut(connection, {
      actor: input.actor,
      boardId: input.boardId,
      lastEventSequence: input.lastEventSequence,
    });
    const parsed = BoardSnapshotParserV1.parse({
      protocolVersion: 1,
      type: 'board.snapshot',
      boardId: input.boardId,
      revision: input.revision,
      scene: input.scene,
      hitl,
      artifacts,
      capabilities,
      lastEventSequence: input.lastEventSequence,
    });
    if (!parsed.ok) throw new BoardPersistenceError('row_integrity');
    return parsed.data.value;
  }
}
