import {
  BoardIdParserV1,
  BoardOperationResultParserV1,
  type BoardId,
  type BoardOperationRequestV1,
  type BoardOperationResultV1,
  type PageCursorV1,
  type RequestId,
  type RevisionId,
  type TimestampV1,
} from '@sceneboard/board-schema';
import type { PoolConnection, RowDataPacket } from 'mysql2/promise';

import { BoardPersistenceError } from '../common/errors/board-persistence.error.js';
import { formatPublicUuidV4 } from '../common/ids/public-uuid.storage.js';
import { formatMysqlTimestampUtc, parseMysqlTimestampUtc } from '../common/time/mysql-timestamp.js';
import type {
  AuthorizedBoardContextV1,
  BoardAccessPolicy,
  ResolvedBoardPrincipalV1,
} from '../grants/board-access.policy.js';
import {
  BoardListCursorCodec,
  type BoardListAccessContextV1,
  type BoardListCursorTupleV1,
} from './board-list-cursor.codec.js';

export type BoardListRequestV1 = BoardOperationRequestV1 & {
  protocolVersion: 1;
  requestId: RequestId;
  type: 'board.list';
  cursor: PageCursorV1 | null;
  limit: number;
  includeArchived: boolean;
};

interface BoardListRow extends RowDataPacket {
  cursorBoardPk: string;
  boardId: string;
  title: string;
  boardCreatedAt: string;
  boardUpdatedAt: string;
  archivedAt: string | null;
  headRevisionId: Buffer;
  headRevisionNumber: string;
  headRevisionCreatedAt: string;
}

const positiveSafeInteger = (value: string): number => {
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

const boardId = (value: string): BoardId => {
  const parsed = BoardIdParserV1.parse(value);
  if (!parsed.ok) throw new BoardPersistenceError('row_integrity');
  return parsed.data.value;
};

const revisionId = (value: Uint8Array): RevisionId => formatPublicUuidV4(value) as RevisionId;

const accessContext = (context: AuthorizedBoardContextV1): BoardListAccessContextV1 =>
  context.access.kind === 'owner'
    ? { accessKind: 'owner', ownerUserId: context.access.ownerUserPk.toString() }
    : { accessKind: 'grant', grantId: context.access.grantId };

export class BoardListService {
  constructor(
    private readonly accessPolicy: BoardAccessPolicy,
    private readonly cursors: BoardListCursorCodec,
  ) {}

  async list(input: {
    principal: ResolvedBoardPrincipalV1;
    request: BoardListRequestV1;
  }): Promise<BoardOperationResultV1> {
    return this.accessPolicy.withAuthorizedBoardTransaction(
      {
        principal: input.principal,
        operation: 'board.list',
        boardId: null,
        isolation: 'REPEATABLE_READ_CUT',
      },
      async (connection, context) => {
        const access = accessContext(context);
        const cursor =
          input.request.cursor === null
            ? null
            : this.cursors.parse({
                cursor: input.request.cursor,
                includeArchived: input.request.includeArchived,
                access,
              });
        const rows = await this.readPage(
          connection,
          context,
          input.request.includeArchived,
          cursor,
          input.request.limit + 1,
        );
        if (rows.length > input.request.limit + 1) throw new BoardPersistenceError('row_integrity');
        const page = rows.slice(0, input.request.limit);
        const boards = page.map((row) => ({
          boardId: boardId(row.boardId),
          title: row.title,
          createdAt: timestamp(row.boardCreatedAt),
          updatedAt: timestamp(row.boardUpdatedAt),
          archivedAt: row.archivedAt === null ? null : timestamp(row.archivedAt),
          headRevision: {
            revisionId: revisionId(row.headRevisionId),
            revisionNumber: positiveSafeInteger(row.headRevisionNumber),
            createdAt: timestamp(row.headRevisionCreatedAt),
          },
        }));
        const last = page.at(-1);
        const nextCursor =
          rows.length > input.request.limit && last !== undefined
            ? this.cursors.issue({
                includeArchived: input.request.includeArchived,
                access,
                tuple: {
                  createdAt: timestamp(last.boardCreatedAt),
                  boardPk: last.cursorBoardPk,
                },
              })
            : null;
        const parsed = BoardOperationResultParserV1.parse({
          protocolVersion: 1,
          type: 'board.operation.result',
          requestId: input.request.requestId,
          replayed: false,
          result: { type: 'board.list', boards, nextCursor },
        });
        if (!parsed.ok) throw new BoardPersistenceError('row_integrity');
        return parsed.data.value;
      },
    );
  }

  private async readPage(
    connection: PoolConnection,
    context: AuthorizedBoardContextV1,
    includeArchived: boolean,
    cursor: BoardListCursorTupleV1 | null,
    limit: number,
  ): Promise<BoardListRow[]> {
    const archived = includeArchived ? '' : 'AND b.archived_at IS NULL';
    const cursorPredicate =
      cursor === null ? '' : 'AND (b.created_at < ? OR (b.created_at = ? AND b.board_pk < ?))';
    const cursorBinds =
      cursor === null
        ? []
        : [
            formatMysqlTimestampUtc(new Date(cursor.createdAt)),
            formatMysqlTimestampUtc(new Date(cursor.createdAt)),
            cursor.boardPk,
          ];
    const membershipPolicyEnabled = context.membership !== undefined;
    const from = membershipPolicyEnabled
      ? context.access.kind === 'owner'
        ? `FROM board_memberships bm
           JOIN boards b ON b.board_pk = bm.board_pk`
        : `FROM mcp_grant_boards gb
           JOIN boards b ON b.public_id = gb.board_public_id
           JOIN board_memberships bm ON bm.board_pk = b.board_pk`
      : context.access.kind === 'owner'
        ? 'FROM boards b'
        : 'FROM mcp_grant_boards gb JOIN boards b ON b.public_id = gb.board_public_id';
    const accessPredicate = membershipPolicyEnabled
      ? context.access.kind === 'owner'
        ? "bm.account_pk = ? AND bm.state = 'active'"
        : "gb.grant_id = ? AND bm.account_pk = ? AND bm.state = 'active'"
      : context.access.kind === 'owner'
        ? 'b.owner_user_id = ?'
        : 'gb.grant_id = ?';
    const accessBinds = membershipPolicyEnabled
      ? context.access.kind === 'owner'
        ? [(context.accountUserPk ?? context.access.ownerUserPk).toString()]
        : [
            context.access.grantPk.toString(),
            (context.accountUserPk ?? context.ownerUserPk).toString(),
          ]
      : context.access.kind === 'owner'
        ? [context.access.ownerUserPk.toString()]
        : [context.access.grantPk.toString()];
    const [rows] = await connection.execute<BoardListRow[]>(
      `
      SELECT
        CAST(b.board_pk AS CHAR) AS cursorBoardPk,
        b.public_id AS boardId,
        b.title,
        b.created_at AS boardCreatedAt,
        b.updated_at AS boardUpdatedAt,
        b.archived_at AS archivedAt,
        hr.revision_id AS headRevisionId,
        CAST(h.head_revision_number AS CHAR) AS headRevisionNumber,
        hr.created_at AS headRevisionCreatedAt
      ${from}
      JOIN board_heads h ON h.board_pk = b.board_pk
      JOIN board_revisions hr
        ON hr.board_pk = h.board_pk
          AND hr.revision_pk = h.head_revision_pk
          AND hr.revision_number = h.head_revision_number
      WHERE ${accessPredicate}
        ${archived}
        ${cursorPredicate}
      ORDER BY b.created_at DESC, b.board_pk DESC
      LIMIT ${limit}
    `,
      [...accessBinds, ...cursorBinds],
    );
    return rows;
  }
}
