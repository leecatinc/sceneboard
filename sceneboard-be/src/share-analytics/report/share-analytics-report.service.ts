import {
  ShareAnalyticsReportParserV1,
  type BoardId,
  type ShareAnalyticsReportV1,
} from '@sceneboard/board-schema';
import type { PoolConnection, RowDataPacket } from 'mysql2/promise';

import { ShareAnalyticsError } from '../../common/errors/share-analytics.error.js';
import { formatPublicUuidV4 } from '../../common/ids/public-uuid.storage.js';
import { parseMysqlTimestampUtc } from '../../common/time/mysql-timestamp.js';
import type { MysqlService } from '../../database/mysql.service.js';
import { withTransaction } from '../../database/transaction.js';

interface BoardRow extends RowDataPacket {
  boardPk: string;
}

interface AggregateRow extends RowDataPacket {
  shareId: string;
  revisionId: Buffer;
  publicationGeneration: string;
  metricKind: 'board-open' | 'page-view';
  pageDimension: string;
  pageOrdinal: number | null;
  titleLabel: string | null;
  metricCount: string;
  lastAggregatedAt: string;
}

interface ReachRow extends RowDataPacket {
  shareId: string;
  revisionId: Buffer;
  publicationGeneration: string;
  estimatedDailyReach: string;
}

interface TotalReachRow extends RowDataPacket {
  estimatedDailyReach: string;
}

type MutablePublication = {
  shareId: string;
  revisionId: string;
  publicationGeneration: number;
  boardOpens: number;
  pageViews: number;
  estimatedDailyReach: number;
  lastAggregatedAt: string | null;
  pages: Array<{
    pageId: string;
    pageOrdinal: number;
    titleLabel: string;
    pageViews: number;
    pageReachBasisPoints: number | null;
  }>;
};

const nonnegative = (value: string): number => {
  if (!/^(?:0|[1-9][0-9]{0,15})$/u.test(value))
    throw new ShareAnalyticsError('SERVICE_UNAVAILABLE');
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new ShareAnalyticsError('SERVICE_UNAVAILABLE');
  return parsed;
};

const positive = (value: string): number => {
  const parsed = nonnegative(value);
  if (parsed < 1) throw new ShareAnalyticsError('SERVICE_UNAVAILABLE');
  return parsed;
};

const safeAdd = (left: number, right: number): number => {
  const result = left + right;
  if (!Number.isSafeInteger(result)) throw new ShareAnalyticsError('SERVICE_UNAVAILABLE');
  return result;
};

const later = (left: string | null, right: string): string => {
  const canonical = parseMysqlTimestampUtc(right).toISOString();
  return left === null || canonical > left ? canonical : left;
};

const basisPoints = (numerator: number, denominator: number): number | null => {
  if (denominator === 0) return null;
  const value =
    (BigInt(numerator) * 10_000n + BigInt(Math.floor(denominator / 2))) / BigInt(denominator);
  return Number(value > 10_000n ? 10_000n : value);
};

export class ShareAnalyticsReportService {
  constructor(private readonly mysql: MysqlService) {}

  async read(input: {
    boardId: BoardId;
    ownerUserPk: bigint;
    from: string;
    to: string;
  }): Promise<ShareAnalyticsReportV1> {
    try {
      return await this.mysql.withConnection((connection) =>
        withTransaction(connection, 'REPEATABLE READ', async () => {
          const boardPk = await this.ownerBoard(connection, input.boardId, input.ownerUserPk);
          const [aggregateRows] = await connection.execute<AggregateRow[]>(
            `SELECT s.share_id AS shareId, r.revision_id AS revisionId,
                    CAST(a.publication_generation AS CHAR) AS publicationGeneration,
                    a.metric_kind AS metricKind, a.page_dimension AS pageDimension,
                    a.page_ordinal AS pageOrdinal, a.title_label AS titleLabel,
                    CAST(SUM(a.metric_count) AS CHAR) AS metricCount,
                    MAX(a.last_aggregated_at) AS lastAggregatedAt
             FROM share_analytics_daily_aggregates a
             JOIN board_shares s ON s.share_pk = a.share_pk
             JOIN board_revisions r
               ON r.board_pk = a.board_pk AND r.revision_pk = a.revision_pk
             WHERE a.board_pk = ? AND a.\`utc_date\` BETWEEN ? AND ?
             GROUP BY s.share_id, r.revision_id, a.publication_generation,
                      a.metric_kind, a.page_dimension, a.page_ordinal, a.title_label
             ORDER BY a.publication_generation DESC, a.page_ordinal, a.page_dimension`,
            [boardPk, input.from, input.to],
          );
          const [reachRows] = await connection.execute<ReachRow[]>(
            `SELECT s.share_id AS shareId, r.revision_id AS revisionId,
                    CAST(v.publication_generation AS CHAR) AS publicationGeneration,
                    CAST(COUNT(*) AS CHAR) AS estimatedDailyReach
             FROM share_analytics_daily_viewers v
             JOIN board_shares s ON s.share_pk = v.share_pk
             JOIN board_revisions r
               ON r.board_pk = v.board_pk AND r.revision_pk = v.revision_pk
             WHERE v.board_pk = ? AND v.\`utc_date\` BETWEEN ? AND ?
             GROUP BY s.share_id, r.revision_id, v.publication_generation`,
            [boardPk, input.from, input.to],
          );
          const [totalReachRows] = await connection.execute<TotalReachRow[]>(
            `SELECT CAST(COUNT(DISTINCT viewer_daily_key) AS CHAR) AS estimatedDailyReach
             FROM share_analytics_daily_viewers
             WHERE board_pk = ? AND \`utc_date\` BETWEEN ? AND ?`,
            [boardPk, input.from, input.to],
          );
          const totalReachRow = totalReachRows[0];
          if (totalReachRows.length !== 1 || totalReachRow === undefined)
            throw new ShareAnalyticsError('SERVICE_UNAVAILABLE');
          const boardEstimatedDailyReach = nonnegative(totalReachRow.estimatedDailyReach);
          const publications = new Map<string, MutablePublication>();
          const obtain = (shareId: string, revisionId: Buffer, generationSource: string) => {
            const publicationGeneration = positive(generationSource);
            const revision = formatPublicUuidV4(revisionId);
            const key = `${shareId}\0${publicationGeneration}\0${revision}`;
            let current = publications.get(key);
            if (current === undefined) {
              current = {
                shareId,
                revisionId: revision,
                publicationGeneration,
                boardOpens: 0,
                pageViews: 0,
                estimatedDailyReach: 0,
                lastAggregatedAt: null,
                pages: [],
              };
              publications.set(key, current);
            }
            return current;
          };
          for (const row of aggregateRows) {
            const publication = obtain(row.shareId, row.revisionId, row.publicationGeneration);
            const count = nonnegative(row.metricCount);
            publication.lastAggregatedAt = later(
              publication.lastAggregatedAt,
              row.lastAggregatedAt,
            );
            if (row.metricKind === 'board-open') {
              if (
                row.pageDimension !== '__BOARD__' ||
                row.pageOrdinal !== null ||
                row.titleLabel !== null
              )
                throw new ShareAnalyticsError('SERVICE_UNAVAILABLE');
              publication.boardOpens = safeAdd(publication.boardOpens, count);
              continue;
            }
            if (
              row.metricKind !== 'page-view' ||
              row.pageDimension === '__BOARD__' ||
              row.pageOrdinal === null ||
              row.titleLabel === null
            )
              throw new ShareAnalyticsError('SERVICE_UNAVAILABLE');
            publication.pageViews = safeAdd(publication.pageViews, count);
            publication.pages.push({
              pageId: row.pageDimension,
              pageOrdinal: row.pageOrdinal,
              titleLabel: row.titleLabel,
              pageViews: count,
              pageReachBasisPoints: null,
            });
          }
          for (const row of reachRows) {
            const publication = obtain(row.shareId, row.revisionId, row.publicationGeneration);
            publication.estimatedDailyReach = nonnegative(row.estimatedDailyReach);
          }
          const ordered = [...publications.values()]
            .sort(
              (left, right) =>
                right.publicationGeneration - left.publicationGeneration ||
                left.shareId.localeCompare(right.shareId) ||
                left.revisionId.localeCompare(right.revisionId),
            )
            .map((publication) => ({
              ...publication,
              pages: publication.pages
                .sort(
                  (left, right) =>
                    left.pageOrdinal - right.pageOrdinal || left.pageId.localeCompare(right.pageId),
                )
                .map((page) => ({
                  ...page,
                  pageReachBasisPoints: basisPoints(page.pageViews, publication.boardOpens),
                })),
            }));
          const totals = ordered.reduce(
            (current, publication) => ({
              boardOpens: safeAdd(current.boardOpens, publication.boardOpens),
              pageViews: safeAdd(current.pageViews, publication.pageViews),
              estimatedDailyReach: boardEstimatedDailyReach,
              lastAggregatedAt:
                publication.lastAggregatedAt === null
                  ? current.lastAggregatedAt
                  : current.lastAggregatedAt === null ||
                      publication.lastAggregatedAt > current.lastAggregatedAt
                    ? publication.lastAggregatedAt
                    : current.lastAggregatedAt,
            }),
            {
              boardOpens: 0,
              pageViews: 0,
              estimatedDailyReach: 0,
              lastAggregatedAt: null as string | null,
            },
          );
          const parsed = ShareAnalyticsReportParserV1.parse({
            boardId: input.boardId,
            from: input.from,
            to: input.to,
            totals,
            publications: ordered,
          });
          if (!parsed.ok) throw new ShareAnalyticsError('SERVICE_UNAVAILABLE');
          return parsed.data.value;
        }),
      );
    } catch (error) {
      if (error instanceof ShareAnalyticsError) throw error;
      throw new ShareAnalyticsError('SERVICE_UNAVAILABLE');
    }
  }

  private async ownerBoard(
    connection: PoolConnection,
    boardId: BoardId,
    ownerUserPk: bigint,
  ): Promise<string> {
    const [rows] = await connection.execute<BoardRow[]>(
      `SELECT CAST(board_pk AS CHAR) AS boardPk
       FROM boards
       WHERE public_id = ? AND owner_user_id = ?
       LIMIT 1`,
      [boardId, ownerUserPk.toString()],
    );
    const row = rows[0];
    if (rows.length !== 1 || row === undefined) throw new ShareAnalyticsError('BOARD_NOT_FOUND');
    return row.boardPk;
  }
}
