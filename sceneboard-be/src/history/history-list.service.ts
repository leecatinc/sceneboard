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
} from '@sceneboard/board-schema';
import type { PoolConnection, RowDataPacket } from 'mysql2/promise';

import { BoardContractError } from '../common/errors/app-error.js';
import { BoardPersistenceError } from '../common/errors/board-persistence.error.js';
import { formatPublicUuidV4 } from '../common/ids/public-uuid.storage.js';
import { parseMysqlTimestampUtc } from '../common/time/mysql-timestamp.js';
import type { BoardAccessPolicy, ResolvedBoardPrincipalV1 } from '../grants/board-access.policy.js';
import { HistoryCursorCodec } from './history-cursor.codec.js';
import {
  historyListMetadata,
  retainedHistoryListMetadata,
  type HistoryHttpMetadataV1,
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
  retainedOrder: string;
  truncatedBefore: number;
  actorAccountPk: string | null;
  actorClass: string;
  sceneSchemaVersion: string;
}

interface HistoryBoundaryRow extends RowDataPacket {
  oldestRetainedRevisionId: Buffer;
  truncatedBefore: number;
}

const notFound = (): BoardContractError =>
  new BoardContractError({
    protocolVersion: 1,
    type: 'board.error',
    code: 'BOARD_NOT_FOUND',
    message: 'Board not found',
    category: 'not_found',
    retryable: false,
    httpStatusHint: 404,
    details: null,
  });

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
const originType = (
  value: string,
): 'board.create' | 'scene.replace' | 'scene.clear' | 'scene.restore' | 'document.replace' => {
  if (value === 'C') return 'board.create';
  if (value === 'R') return 'scene.replace';
  if (value === 'L') return 'scene.clear';
  if (value === 'S') return 'scene.restore';
  if (value === 'D') return 'document.replace';
  throw new BoardPersistenceError('row_integrity');
};

export class HistoryListService {
  constructor(
    private readonly accessPolicy: BoardAccessPolicy,
    private readonly cursors: HistoryCursorCodec,
    private readonly emitRetainedMetadata = false,
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
  }): Promise<{ result: BoardOperationResultV1; metadata: HistoryHttpMetadataV1 }> {
    return this.accessPolicy.withAuthorizedBoardTransaction(
      {
        principal: input.principal,
        operation: 'history.list',
        boardId: input.request.boardId,
        isolation: 'REPEATABLE_READ_CUT',
      },
      async (connection) => {
        const before =
          input.request.cursor === null
            ? null
            : this.cursors.parseAnchor(input.request.cursor, input.request.boardId);
        if (before !== null) {
          await this.assertCursorAnchor(connection, input.request.boardId, before);
        }
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
          previousRevisionId:
            row.previousRevisionId === null ? null : revisionId(row.previousRevisionId),
          originType: originType(row.originCode),
          sourceRevisionId: row.sourceRevisionId === null ? null : revisionId(row.sourceRevisionId),
          actor: {
            principalKind: principalKind(row.actorKind),
            principalId: principalId(row.actorPrincipalId),
          },
        }));
        const last = entries.at(-1);
        const nextCursor =
          rows.length > input.request.limit && last !== undefined
            ? this.emitRetainedMetadata
              ? this.cursors.issueRetained(
                  input.request.boardId,
                  positive(page.at(-1)?.retainedOrder ?? ''),
                )
              : this.cursors.issue(input.request.boardId, last.revision.revisionNumber)
            : null;
        const parsed = BoardOperationResultParserV1.parse({
          protocolVersion: 1,
          type: 'board.operation.result',
          requestId: input.request.requestId,
          replayed: false,
          result: { type: 'history.list', entries, nextCursor },
        });
        if (!parsed.ok) throw new BoardPersistenceError('row_integrity');
        const retainedBoundary = this.emitRetainedMetadata
          ? await this.readBoundary(connection, input.request.boardId)
          : null;
        return {
          result: parsed.data.value,
          metadata: this.emitRetainedMetadata
            ? retainedHistoryListMetadata(
                entries.map((entry, index) => {
                  const row = page[index];
                  if (row === undefined) throw new BoardPersistenceError('row_integrity');
                  if (row.sceneSchemaVersion !== '1.0.0' && row.sceneSchemaVersion !== '2.0.0') {
                    throw new BoardPersistenceError('row_integrity');
                  }
                  return {
                    entry,
                    actorLabel:
                      row.actorClass === 'system'
                        ? 'system'
                        : input.principal.kind === 'user' &&
                            row.actorAccountPk === input.principal.userPk.toString()
                          ? 'self'
                          : row.actorClass === 'owner'
                            ? 'owner'
                            : 'editor',
                    schemaVersion: row.sceneSchemaVersion,
                  };
                }),
                {
                  truncatedBefore: retainedBoundary?.truncatedBefore === 1,
                  oldestRetainedRevisionId: revisionId(
                    retainedBoundary?.oldestRetainedRevisionId ??
                      (() => {
                        throw new BoardPersistenceError('row_integrity');
                      })(),
                  ),
                },
              )
            : historyListMetadata(
                entries,
                page.map((row) => row.label),
              ),
        };
      },
    );
  }

  private async assertCursorAnchor(
    connection: PoolConnection,
    boardId: BoardId,
    anchor: { version: 1 | 2; value: number },
  ): Promise<void> {
    const predicate = anchor.version === 1 ? 'r.revision_number = ?' : 'c.retained_order = ?';
    const [rows] = await connection.execute<RowDataPacket[]>(
      `
      SELECT c.revision_pk
      FROM boards b
      JOIN board_revision_catalog c ON c.board_pk = b.board_pk
      JOIN board_revisions r ON r.board_pk = c.board_pk AND r.revision_pk = c.revision_pk
      WHERE b.public_id = ? AND ${predicate}
      LIMIT 1
    `,
      [boardId, anchor.value],
    );
    if (rows.length !== 1) throw notFound();
  }

  private async readBoundary(
    connection: PoolConnection,
    boardId: BoardId,
  ): Promise<HistoryBoundaryRow> {
    const [rows] = await connection.execute<HistoryBoundaryRow[]>(
      `
      SELECT oldest.revision_id AS oldestRetainedRevisionId,
             oldest_catalog.truncated_before AS truncatedBefore
      FROM boards b
      JOIN board_revision_catalog oldest_catalog
        ON oldest_catalog.board_pk = b.board_pk
       AND oldest_catalog.retained_order = (
         SELECT MIN(c.retained_order)
         FROM board_revision_catalog c
         WHERE c.board_pk = b.board_pk
       )
      JOIN board_revisions oldest
        ON oldest.board_pk = oldest_catalog.board_pk
       AND oldest.revision_pk = oldest_catalog.revision_pk
      WHERE b.public_id = ?
      LIMIT 1
    `,
      [boardId],
    );
    const row = rows[0];
    if (rows.length !== 1 || row === undefined) throw new BoardPersistenceError('row_integrity');
    return row;
  }

  private async readPage(
    connection: PoolConnection,
    boardId: HistoryListRequestV1['boardId'],
    before: { version: 1 | 2; value: number } | null,
    limit: number,
  ): Promise<HistoryListRow[]> {
    const boundary =
      before === null
        ? 'c.retained_order <= head_catalog.retained_order'
        : before.version === 1
          ? `r.revision_number < ?
             AND EXISTS (
               SELECT 1
               FROM board_revision_catalog cursor_catalog
               JOIN board_revisions cursor_revision
                 ON cursor_revision.board_pk = cursor_catalog.board_pk
                AND cursor_revision.revision_pk = cursor_catalog.revision_pk
               WHERE cursor_catalog.board_pk = b.board_pk
                 AND cursor_revision.revision_number = ?
             )`
          : 'c.retained_order < ?';
    const [rows] = await connection.execute<HistoryListRow[]>(
      `
      SELECT
        r.revision_id AS revisionId,
        CAST(r.revision_number AS CHAR) AS revisionNumber,
        r.created_at AS revisionCreatedAt,
        previous.revision_id AS previousRevisionId,
        source.revision_id AS sourceRevisionId,
        r.origin_code AS originCode,
        r.actor_kind AS actorKind,
        r.actor_principal_id AS actorPrincipalId,
        r.label,
        CAST(c.retained_order AS CHAR) AS retainedOrder,
        c.truncated_before AS truncatedBefore,
        CAST(c.actor_account_pk AS CHAR) AS actorAccountPk,
        c.actor_class AS actorClass,
        COALESCE(p.schema_version, r.scene_schema_version) AS sceneSchemaVersion
      FROM boards b
      JOIN board_heads h ON h.board_pk = b.board_pk
      JOIN board_revision_catalog head_catalog
        ON head_catalog.board_pk = h.board_pk AND head_catalog.revision_pk = h.head_revision_pk
      JOIN board_revision_catalog c ON c.board_pk = b.board_pk
      JOIN board_revisions r ON r.board_pk = c.board_pk AND r.revision_pk = c.revision_pk
      LEFT JOIN board_revision_payloads p ON p.revision_pk = r.revision_pk
      LEFT JOIN board_revision_catalog previous_catalog
        ON previous_catalog.board_pk = c.board_pk
       AND previous_catalog.retained_order = (
         SELECT MAX(pc.retained_order)
         FROM board_revision_catalog pc
         WHERE pc.board_pk = c.board_pk AND pc.retained_order < c.retained_order
       )
      LEFT JOIN board_revisions previous
        ON previous.board_pk = previous_catalog.board_pk
       AND previous.revision_pk = previous_catalog.revision_pk
      LEFT JOIN board_revisions source
        ON source.board_pk = r.board_pk AND source.revision_pk = r.source_revision_pk
      WHERE b.public_id = ? AND ${boundary}
      ORDER BY c.retained_order DESC
      LIMIT ${limit}
    `,
      before === null
        ? [boardId]
        : before.version === 1
          ? [boardId, before.value, before.value]
          : [boardId, before.value],
    );
    return rows;
  }
}
