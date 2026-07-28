import {
  BoardOperationResultParserV1,
  PROTOCOL_SEMVER,
  type BoardId,
  type BoardSummaryV1,
  type PrincipalId,
  type RequestId,
  type RevisionId,
  type TimestampV1,
} from '@sceneboard/board-schema';
import type { PoolConnection, RowDataPacket } from 'mysql2/promise';

import { BoardContractError } from '../common/errors/app-error.js';
import { formatPublicUuidV4 } from '../common/ids/public-uuid.storage.js';
import { parseMysqlTimestampUtc } from '../common/time/mysql-timestamp.js';
import type { BoardAccessPolicy, ResolvedBoardPrincipalV1 } from '../grants/board-access.policy.js';
import { currentBoardCapabilitiesFromContext } from '../grants/current-board-capabilities.js';
import type {
  AuthorizedBrowserPresencePortV1,
  AuthorizedBrowserPresenceSubjectV1,
} from '../presence/ports/authorized-browser-presence.port.js';
import type { SafeAuthorizedConnectionV1 } from './mcp-connection.dto.js';

interface BoardSummaryRow extends RowDataPacket {
  boardId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  revisionId: Buffer;
  revisionNumber: string;
  revisionCreatedAt: string;
}

const failure = (code: 'UNAUTHENTICATED' | 'INTERNAL_ERROR'): BoardContractError =>
  new BoardContractError(
    code === 'UNAUTHENTICATED'
      ? {
          protocolVersion: 1,
          type: 'board.error',
          code,
          message: 'Authentication is required',
          category: 'auth',
          retryable: false,
          httpStatusHint: 401,
          details: null,
        }
      : {
          protocolVersion: 1,
          type: 'board.error',
          code,
          message: 'Internal server error',
          category: 'internal',
          retryable: false,
          httpStatusHint: 500,
          details: null,
        },
  );

const positive = (value: string): number => {
  if (!/^[1-9][0-9]{0,15}$/.test(value)) throw failure('INTERNAL_ERROR');
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw failure('INTERNAL_ERROR');
  return parsed;
};

const timestamp = (value: string): TimestampV1 => {
  try {
    return parseMysqlTimestampUtc(value).toISOString() as TimestampV1;
  } catch {
    throw failure('INTERNAL_ERROR');
  }
};

export class McpConnectionService {
  constructor(
    private readonly accessPolicy: BoardAccessPolicy,
    private readonly presence: AuthorizedBrowserPresencePortV1,
  ) {}

  async get(input: {
    principal: ResolvedBoardPrincipalV1;
    requestId: RequestId;
    boardId: BoardId | null;
  }): Promise<SafeAuthorizedConnectionV1> {
    if (
      input.principal.kind !== 'mcp' ||
      input.principal.connectionGrant === undefined ||
      input.principal.actor.grantId !== input.principal.grantId
    )
      throw failure('UNAUTHENTICATED');
    const base = {
      principal: {
        principalKind: 'mcp_client' as const,
        principalId: input.principal.actor.principalId as PrincipalId,
        grantId: input.principal.grantId,
      },
      grant: input.principal.connectionGrant,
      versions: {
        mcpServer: '0.0.0' as const,
        boardProtocol: PROTOCOL_SEMVER,
        api: 'v1' as const,
      },
    };
    if (input.boardId === null) return { ...base, selectedBoard: null };
    let subject: AuthorizedBrowserPresenceSubjectV1 | null = null;
    const selected = await this.accessPolicy.withAuthorizedBoardTransaction(
      {
        principal: input.principal,
        operation: 'board.get',
        boardId: input.boardId,
        isolation: 'REPEATABLE_READ_CUT',
      },
      async (connection, context) => {
        const board = await this.readBoardSummary(connection, input.requestId, input.boardId!);
        subject = this.presence.captureAuthorizedSubject(context, input.boardId!);
        return {
          board,
          capabilities: currentBoardCapabilitiesFromContext(context),
          capabilityEpoch: context.membership?.capabilityEpoch ?? 0,
        };
      },
    );
    const browserPresence =
      subject === null
        ? 'unknown'
        : await this.presence.getStatus(subject).catch(() => 'unknown' as const);
    return { ...base, selectedBoard: { ...selected, browserPresence } };
  }

  private async readBoardSummary(
    connection: PoolConnection,
    requestId: RequestId,
    boardId: BoardId,
  ): Promise<BoardSummaryV1> {
    const [rows] = await connection.execute<BoardSummaryRow[]>(
      `
      SELECT
        b.public_id AS boardId,
        b.title,
        b.created_at AS createdAt,
        b.updated_at AS updatedAt,
        b.archived_at AS archivedAt,
        r.revision_id AS revisionId,
        CAST(r.revision_number AS CHAR) AS revisionNumber,
        r.created_at AS revisionCreatedAt
      FROM boards b
      JOIN board_heads h ON h.board_pk = b.board_pk
      JOIN board_revisions r ON r.revision_pk = h.head_revision_pk AND r.board_pk = b.board_pk
      WHERE b.public_id = ?
      LIMIT 1
    `,
      [boardId],
    );
    const row = rows[0];
    if (
      rows.length !== 1 ||
      row === undefined ||
      row.boardId !== boardId ||
      !Buffer.isBuffer(row.revisionId)
    ) {
      throw failure('INTERNAL_ERROR');
    }
    let revisionId: RevisionId;
    try {
      revisionId = formatPublicUuidV4(row.revisionId) as RevisionId;
    } catch {
      throw failure('INTERNAL_ERROR');
    }
    const result = BoardOperationResultParserV1.parse({
      protocolVersion: 1,
      type: 'board.operation.result',
      requestId,
      replayed: false,
      result: {
        type: 'board.list',
        boards: [
          {
            boardId,
            title: row.title,
            createdAt: timestamp(row.createdAt),
            updatedAt: timestamp(row.updatedAt),
            archivedAt: row.archivedAt === null ? null : timestamp(row.archivedAt),
            headRevision: {
              revisionId,
              revisionNumber: positive(row.revisionNumber),
              createdAt: timestamp(row.revisionCreatedAt),
            },
          },
        ],
        nextCursor: null,
      },
    });
    if (
      !result.ok ||
      result.data.value.result.type !== 'board.list' ||
      result.data.value.result.boards.length !== 1
    ) {
      throw failure('INTERNAL_ERROR');
    }
    return result.data.value.result.boards[0]!;
  }
}
