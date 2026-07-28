import {
  BoardSnapshotParser,
  BoardSnapshotParserV1,
  BoardSnapshotParserV2,
  type ActorContextV1,
  type BoardCapabilities,
  type BoardId,
  type BoardSnapshot,
  type BoardSnapshotV1,
  type BoardSnapshotV2,
  type RevisionSummaryV1,
} from '@sceneboard/board-schema';
import type { PoolConnection } from 'mysql2/promise';

import { BoardPersistenceError } from '../common/errors/board-persistence.error.js';
import type { CurrentArtifactRuntimeSummaryPort } from '../snapshots/ports/current-artifact-runtime-summary.port.js';
import type { CurrentHitlSummaryPort } from '../snapshots/ports/current-hitl-summary.port.js';

import type { DecodedBoardCheckpoint } from './document-checkpoint.codec.js';

export interface SnapshotCompositionInput {
  actor: ActorContextV1;
  boardId: BoardId;
  revision: RevisionSummaryV1 & {
    previousRevisionId: BoardSnapshot['revision']['previousRevisionId'];
    originType: BoardSnapshot['revision']['originType'];
    sourceRevisionId: BoardSnapshot['revision']['sourceRevisionId'];
    actor: BoardSnapshot['revision']['actor'];
  };
  checkpoint: DecodedBoardCheckpoint;
  lastEventSequence: number;
}

export type SnapshotCompositionInputV1 = Omit<SnapshotCompositionInput, 'checkpoint'> & {
  checkpoint: Extract<DecodedBoardCheckpoint, { kind: 'scene' }>;
};

export type SnapshotCompositionInputV2 = Omit<SnapshotCompositionInput, 'checkpoint'> & {
  checkpoint: Extract<DecodedBoardCheckpoint, { kind: 'document' }>;
};

export interface CurrentBoardCapabilitiesPort {
  readAuthorizedAtCut(
    connection: PoolConnection,
    input: Pick<SnapshotCompositionInput, 'actor' | 'boardId' | 'lastEventSequence'> & {
      checkpointSchemaVersion: 1 | 2;
    },
  ): Promise<BoardCapabilities>;
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
    const snapshot = await this.composeCheckpoint(connection, input);
    const parsed = BoardSnapshotParserV1.parse(snapshot);
    if (!parsed.ok) throw new BoardPersistenceError('row_integrity');
    return parsed.data.value;
  }

  async composeDocument(
    connection: PoolConnection,
    input: SnapshotCompositionInputV2,
  ): Promise<BoardSnapshotV2> {
    const snapshot = await this.composeCheckpoint(connection, input);
    const parsed = BoardSnapshotParserV2.parse(snapshot);
    if (!parsed.ok) throw new BoardPersistenceError('row_integrity');
    return parsed.data.value;
  }

  private async composeCheckpoint(
    connection: PoolConnection,
    input: SnapshotCompositionInput,
  ): Promise<BoardSnapshot> {
    const hitl = await this.hitl.readAuthorizedAtCut(connection, input);
    const artifacts = await this.artifacts.readAuthorizedAtCut(connection, input);
    const capabilities = await this.capabilities.readAuthorizedAtCut(connection, {
      actor: input.actor,
      boardId: input.boardId,
      lastEventSequence: input.lastEventSequence,
      checkpointSchemaVersion: input.checkpoint.kind === 'scene' ? 1 : 2,
    });
    const parsed = BoardSnapshotParser.parse({
      protocolVersion: 1,
      type: 'board.snapshot',
      boardId: input.boardId,
      revision: input.revision,
      ...(input.checkpoint.kind === 'scene'
        ? { scene: input.checkpoint.scene }
        : { document: input.checkpoint.document }),
      hitl,
      artifacts,
      capabilities,
      lastEventSequence: input.lastEventSequence,
    });
    if (!parsed.ok) throw new BoardPersistenceError('row_integrity');
    return parsed.data.value;
  }
}
