import {
  BoardOperationResultParserV1,
  PrincipalIdParserV1,
  type BoardId,
  type BoardOperationRequestV1,
  type BoardOperationResultV1,
  type HistoryEntryV1,
  type PageCursorV1,
  type PrincipalId,
  type RequestId,
  type RevisionId,
  type TimestampV1,
} from '@leecat-board/board-schema';
import type { PoolConnection, RowDataPacket } from 'mysql2/promise';

import { BoardPersistenceError } from '../common/errors/board-persistence.error.js';
import { formatPublicUuidV4 } from '../common/ids/public-uuid.storage.js';
import { parseMysqlTimestampUtc } from '../common/time/mysql-timestamp.js';
import type { BoardAccessPolicy, ResolvedBoardPrincipalV1 } from '../grants/board-access.policy.js';
import { HistoryCursorCodec } from './history-cursor.codec.js';
import {
  historyListMetadata,
  type HistoryAdapterMetadataV1,
} from './history-adapter-metadata.js';

export type HistoryListRequestV1 = BoardOperationRequestV1 & {
  protocolVersion: 1;
  requestId: RequestId;
  type: 'history.list';
  boardId: BoardId;
  cursor: PageCursorV1 | null;
  limit: number;
};

interface HistoryListRow extends RowDataPacket {
  revisionId: Buffer;
  revisionNumber: string;
  revisionCreatedAt: string;
  previousRevisionId: Buffer | null;
  sourceRevisionId: Buffer | null;
  originCode: string;
  actorKind: string;
  actorPrincipalId: string;
  label: string;
}

const revisionId = (value: Uint8Array): RevisionId => formatPublicUuidV4(value) as RevisionId;
const positive = (value: string): number => {
  if (!/^[1-9][0-9]{0,15}$/.test(value)) throw new BoardPersistenceError('row_integrity');
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new BoardPersistenceError('row_integrity');
  return parsed;
};
const timestamp = (value: string): TimestampV1 => {
  try {
    return parseMysqlTimestampUtc(value).toISOString() as TimestampV1;
  } catch (error) {
    throw new BoardPersistenceError('row_integrity', error);
  }
};
const principalId = (value: string): PrincipalId => {
  const parsed = PrincipalIdParserV1.parse(value);
  if (!parsed.ok) throw new BoardPersistenceError('row_integrity');
  return parsed.data.value;
};
const principalKind = (value: string): 'user' | 'mcp_client' | 'service' => {
  if (value === 'U') return 'user';
  if (value === 'M') return 'mcp_client';
  if (value === 'S') return 'service';
  throw new BoardPersistenceError('row_integrity');
};
const originType = (value: string): 'board.create' | 'scene.replace' | 'scene.clear' | 'scene.restore' => {
  if (value === 'C') return 'board.create';
  if (value === 'R') return 'scene.replace';
  if (value === 'L') return 'scene.clear';
  if (value === 'S') return 'scene.restore';
  throw new BoardPersistenceError('row_integrity');
};

export class HistoryListService {
  constructor(
    private readonly accessPolicy: BoardAccessPolicy,
    private readonly cursors: HistoryCursorCodec,
  ) {}

  async list(input: {
    principal: ResolvedBoardPrincipalV1;
    request: HistoryListRequestV1;
  }): Promise<BoardOperationResultV1> {
    return (await this.listWithMetadata(input)).result;
  }

  async listWithMetadata(input: {
    principal: ResolvedBoardPrincipalV1;
    request: HistoryListRequestV1;
  }): Promise<{ result: BoardOperationResultV1; metadata: HistoryAdapterMetadataV1 }> {
    return this.accessPolicy.withAuthorizedBoardTransaction({
      principal: input.principal,
      operation: 'history.list',
      boardId: input.request.boardId,
      isolation: 'REPEATABLE_READ_CUT',
    }, async (connection) => {
      const before = input.request.cursor === null
        ? null
        : this.cursors.parse(input.request.cursor, input.request.boardId);
      const rows = await this.readPage(
        connection,
        input.request.boardId,
        before,
        input.request.limit + 1,
      );
      if (rows.length > input.request.limit + 1) throw new BoardPersistenceError('row_integrity');
      const page = rows.slice(0, input.request.limit);
      const entries: HistoryEntryV1[] = page.map((row) => ({
        revision: {
          revisionId: revisionId(row.revisionId),
          revisionNumber: positive(row.revisionNumber),
          createdAt: timestamp(row.revisionCreatedAt),
        },
        previousRevisionId: row.previousRevisionId === null ? null : revisionId(row.previousRevisionId),
        originType: originType(row.originCode),
        sourceRevisionId: row.sourceRevisionId === null ? null : revisionId(row.sourceRevisionId),
        actor: {
          principalKind: principalKind(row.actorKind),
          principalId: principalId(row.actorPrincipalId),
        },
      }));
      const last = entries.at(-1);
      const nextCursor = rows.length > input.request.limit && last !== undefined
        ? this.cursors.issue(input.request.boardId, last.revision.revisionNumber)
        : null;
      const parsed = BoardOperationResultParserV1.parse({
        protocolVersion: 1,
        type: 'board.operation.result',
        requestId: input.request.requestId,
        replayed: false,
        result: { type: 'history.list', entries, nextCursor },
      });
      if (!parsed.ok) throw new BoardPersistenceError('row_integrity');
      return {
        result: parsed.data.value,
        metadata: historyListMetadata(entries, page.map((row) => row.label)),
      };
    });
  }

  private async readPage(
    connection: PoolConnection,
    boardId: HistoryListRequestV1['boardId'],
    before: number | null,
    limit: number,
  ): Promise<HistoryListRow[]> {
    const boundary = before === null
      ? 'r.revision_number <= h.head_revision_number'
      : 'r.revision_number < ?';
    const [rows] = await connection.execute<HistoryListRow[]>(`
      SELECT
        r.revision_id AS revisionId,
        CAST(r.revision_number AS CHAR) AS revisionNumber,
        r.created_at AS revisionCreatedAt,
        previous.revision_id AS previousRevisionId,
        source.revision_id AS sourceRevisionId,
        r.origin_code AS originCode,
        r.actor_kind AS actorKind,
        r.actor_principal_id AS actorPrincipalId,
        r.label
      FROM boards b
      JOIN board_heads h ON h.board_pk = b.board_pk
      JOIN board_revisions r ON r.board_pk = b.board_pk
      LEFT JOIN board_revisions previous
        ON previous.board_pk = r.board_pk AND previous.revision_pk = r.previous_revision_pk
      LEFT JOIN board_revisions source
        ON source.board_pk = r.board_pk AND source.revision_pk = r.source_revision_pk
      WHERE b.public_id = ? AND ${boundary}
      ORDER BY r.revision_number DESC
      LIMIT ${limit}
    `, before === null ? [boardId] : [boardId, before]);
    return rows;
  }
}
