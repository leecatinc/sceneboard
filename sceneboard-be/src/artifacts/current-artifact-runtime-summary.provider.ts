import { Injectable } from '@nestjs/common';
import {
  ArtifactRuntimeSummaryParserV1,
  type ArtifactRuntimeSummaryV1,
  type BoardErrorCodeV1,
  type TimestampV1,
} from '@sceneboard/board-schema';
import type { PoolConnection, RowDataPacket } from 'mysql2/promise';

import { BoardPersistenceError } from '../common/errors/board-persistence.error.js';
import { parseMysqlTimestampUtc } from '../common/time/mysql-timestamp.js';
import { extractUniqueSceneArtifactPairs } from '../revisions/scene-artifact-reference.extractor.js';
import type { SnapshotCompositionInputV1 } from '../revisions/snapshot-composition.service.js';
import { CurrentArtifactRuntimeSummaryPort } from '../snapshots/ports/current-artifact-runtime-summary.port.js';

interface RuntimeRow extends RowDataPacket {
  inputOrdinal: number;
  artifactId: string;
  versionId: string;
  statusCode: string;
  failureCode: string | null;
  failureMessage: string | null;
  lastEventSequence: string;
  updatedAt: string;
}

const status = (code: string): ArtifactRuntimeSummaryV1['status'] => {
  if (code === 'R') return 'ready';
  if (code === 'S') return 'stopped';
  if (code === 'F') return 'failed';
  if (code === 'B') return 'blocked';
  throw new BoardPersistenceError('row_integrity');
};

@Injectable()
export class CurrentArtifactRuntimeSummaryProvider extends CurrentArtifactRuntimeSummaryPort {
  async readAuthorizedAtCut(
    connection: PoolConnection,
    input: SnapshotCompositionInputV1,
  ): Promise<readonly ArtifactRuntimeSummaryV1[]> {
    const pairs = extractUniqueSceneArtifactPairs(input.scene);
    const summaries: ArtifactRuntimeSummaryV1[] = [];
    for (let offset = 0; offset < pairs.length; offset += 100) {
      const batch = pairs.slice(offset, offset + 100);
      const selects = batch
        .map((_, index) =>
          index === 0
            ? 'SELECT ? AS input_ordinal, ? AS artifact_id, ? AS version_id'
            : 'UNION ALL SELECT ?, ?, ?',
        )
        .join('\n');
      const binds = batch.flatMap((pair, index) => [
        offset + index,
        pair.artifactId,
        pair.artifactVersionId,
      ]);
      const [rows] = await connection.execute<RuntimeRow[]>(
        `
        SELECT requested.input_ordinal AS inputOrdinal,
               a.artifact_id AS artifactId, v.version_id AS versionId,
               s.status_code AS statusCode, s.failure_code AS failureCode,
               s.failure_message AS failureMessage,
               CAST(s.last_event_sequence AS CHAR) AS lastEventSequence,
               s.updated_at AS updatedAt
        FROM (${selects}) requested
        JOIN artifacts a ON a.board_pk = (
          SELECT board_pk FROM boards WHERE public_id = ?
        ) AND a.artifact_id = requested.artifact_id
        JOIN artifact_versions v
          ON v.artifact_pk = a.artifact_pk AND v.board_pk = a.board_pk
          AND v.version_id = requested.version_id
        JOIN artifact_runtime_states s ON s.version_pk = v.version_pk
        ORDER BY requested.input_ordinal ASC
      `,
        [...binds, input.boardId],
      );
      if (rows.length !== batch.length) throw new BoardPersistenceError('row_integrity');
      for (let index = 0; index < rows.length; index += 1) {
        const row = rows[index];
        const pair = batch[index];
        if (
          row === undefined ||
          pair === undefined ||
          row.inputOrdinal !== offset + index ||
          row.artifactId !== pair.artifactId ||
          row.versionId !== pair.artifactVersionId ||
          !/^[1-9][0-9]{0,15}$/u.test(row.lastEventSequence)
        ) {
          throw new BoardPersistenceError('row_integrity');
        }
        const sequence = Number(row.lastEventSequence);
        if (!Number.isSafeInteger(sequence) || sequence > input.lastEventSequence) {
          throw new BoardPersistenceError('row_integrity');
        }
        const parsed = ArtifactRuntimeSummaryParserV1.parse({
          artifact: { artifactId: row.artifactId, versionId: row.versionId },
          status: status(row.statusCode),
          updatedAt: parseMysqlTimestampUtc(row.updatedAt).toISOString() as TimestampV1,
          failure:
            row.failureCode === null || row.failureMessage === null
              ? null
              : { code: row.failureCode as BoardErrorCodeV1, message: row.failureMessage },
        });
        if (!parsed.ok) throw new BoardPersistenceError('row_integrity');
        summaries.push(parsed.data.value);
      }
    }
    return summaries;
  }
}
