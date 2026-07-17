import { BoardIdParserV1, type BoardId, type ShortText, type TimestampV1 } from '@leecat-board/board-schema';
import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise';

import { BoardPersistenceError } from '../common/errors/board-persistence.error.js';
import { parseMysqlTimestampUtc } from '../common/time/mysql-timestamp.js';
import type { BoardAccessPolicy, ResolvedBoardPrincipalV1 } from '../grants/board-access.policy.js';

interface RenamedBoardRow extends RowDataPacket {
  boardId: string;
  title: string;
  updatedAt: string;
}

export interface BoardRenameRequestV1 {
  boardId: BoardId;
  title: ShortText;
}

export interface BoardRenameResultV1 {
  boardId: BoardId;
  title: ShortText;
  updatedAt: TimestampV1;
}

export class BoardRenameService {
  constructor(private readonly accessPolicy: BoardAccessPolicy) {}

  async rename(input: {
    principal: Extract<ResolvedBoardPrincipalV1, { kind: 'user' }>;
    request: BoardRenameRequestV1;
  }): Promise<BoardRenameResultV1> {
    return this.accessPolicy.withAuthorizedBoardTransaction({
      principal: input.principal,
      operation: 'board.rename',
      boardId: input.request.boardId,
      isolation: 'READ_COMMITTED_WRITE',
    }, async (connection, context) => {
      if (context.access.kind !== 'owner') throw new BoardPersistenceError('row_integrity');
      const [update] = await connection.execute<ResultSetHeader>(`
        UPDATE boards
        SET title = ?, updated_at = UTC_TIMESTAMP(3)
        WHERE public_id = ? AND owner_user_id = ? AND archived_at IS NULL
      `, [input.request.title, input.request.boardId, context.ownerUserPk.toString()]);
      if (update.affectedRows !== 1) throw new BoardPersistenceError('row_integrity');
      const [rows] = await connection.execute<RenamedBoardRow[]>(`
        SELECT public_id AS boardId, title, updated_at AS updatedAt
        FROM boards
        WHERE public_id = ? AND owner_user_id = ? AND archived_at IS NULL
        LIMIT 1
      `, [input.request.boardId, context.ownerUserPk.toString()]);
      const row = rows[0];
      const boardId = BoardIdParserV1.parse(row?.boardId);
      if (rows.length !== 1 || row === undefined || !boardId.ok || boardId.data.value !== input.request.boardId
        || row.title !== input.request.title) throw new BoardPersistenceError('row_integrity');
      return {
        boardId: boardId.data.value,
        title: input.request.title,
        updatedAt: parseMysqlTimestampUtc(row.updatedAt).toISOString() as TimestampV1,
      };
    });
  }
}
