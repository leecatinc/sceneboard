import type { HitlInteractionV1 } from '@leecat-board/board-schema';
import type { PoolConnection } from 'mysql2/promise';

import { BoardPersistenceError } from '../common/errors/board-persistence.error.js';
import { extractUniqueSceneHitlRequestIds } from '../revisions/scene-hitl-reference.extractor.js';
import type { SnapshotCompositionInputV1 } from '../revisions/snapshot-composition.service.js';
import { CurrentHitlSummaryPort } from '../snapshots/ports/current-hitl-summary.port.js';
import {
  INTERACTION_ROW_COLUMNS,
} from './persistence/interaction.repository.js';
import {
  mapInteractionRowV1,
  type InteractionRowV1,
} from './persistence/interaction-row.mapper.js';

interface SnapshotInteractionRowV1 extends InteractionRowV1 {
  inputOrdinal: number | string;
}

export class CurrentHitlSummaryProvider extends CurrentHitlSummaryPort {
  async readAuthorizedAtCut(
    connection: PoolConnection,
    input: SnapshotCompositionInputV1,
  ): Promise<readonly HitlInteractionV1[]> {
    const ids = extractUniqueSceneHitlRequestIds(input.scene);
    const summaries: HitlInteractionV1[] = [];
    for (let offset = 0; offset < ids.length; offset += 100) {
      const batch = ids.slice(offset, offset + 100);
      const selects = batch.map((_, index) => (
        index === 0
          ? 'SELECT ? AS input_ordinal, ? AS hitl_request_id'
          : 'UNION ALL SELECT ?, ?'
      )).join('\n');
      const binds = batch.flatMap((id, index) => [offset + index, id]);
      const [rows] = await connection.execute<SnapshotInteractionRowV1[]>(`
        SELECT requested.input_ordinal AS inputOrdinal, ${INTERACTION_ROW_COLUMNS}
        FROM (${selects}) requested
        JOIN boards b ON b.public_id = ?
        JOIN board_hitl_interactions i
          ON i.board_pk = b.board_pk AND i.hitl_request_id = requested.hitl_request_id
        ORDER BY requested.input_ordinal ASC
      `, [...binds, input.boardId]);
      if (rows.length !== batch.length) throw new BoardPersistenceError('row_integrity');
      for (let index = 0; index < rows.length; index += 1) {
        const row = rows[index];
        const expectedId = batch[index];
        if (row === undefined || expectedId === undefined
          || Number(row.inputOrdinal) !== offset + index || row.hitlRequestId !== expectedId) {
          throw new BoardPersistenceError('row_integrity');
        }
        const stored = mapInteractionRowV1(row);
        if (stored.stateEventSequence > input.lastEventSequence) {
          throw new BoardPersistenceError('row_integrity');
        }
        summaries.push(stored.interaction);
      }
    }
    return summaries;
  }
}
