import type { PoolConnection, ResultSetHeader } from 'mysql2/promise';

import { ShareAnalyticsError } from '../../common/errors/share-analytics.error.js';
import type { MysqlService } from '../../database/mysql.service.js';
import { withTransaction } from '../../database/transaction.js';

export class ShareAnalyticsRetentionService {
  constructor(private readonly mysql: MysqlService) {}

  async expireBatch(limit = 500): Promise<number> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 5_000)
      throw new TypeError('analytics cleanup limit is outside the supported range');
    try {
      return await this.mysql.withConnection((connection) =>
        withTransaction(connection, 'READ COMMITTED', async () => {
          let removed = 0;
          removed += await this.deleteLimited(
            connection,
            'share_analytics_replays',
            'expires_at < UTC_TIMESTAMP(3)',
            limit,
          );
          removed += await this.deleteLimited(
            connection,
            'share_analytics_rolling_admissions',
            'expires_at < UTC_TIMESTAMP(3)',
            limit,
          );
          removed += await this.deleteLimited(
            connection,
            'share_analytics_context_pages',
            `context_id IN (
               SELECT context_id FROM share_analytics_contexts
               WHERE expires_at < UTC_TIMESTAMP(3)
             )`,
            limit,
          );
          removed += await this.deleteLimited(
            connection,
            'share_analytics_contexts',
            `expires_at < UTC_TIMESTAMP(3)
             AND NOT EXISTS (
               SELECT 1 FROM share_analytics_replays r
               WHERE r.context_id = share_analytics_contexts.context_id
             )`,
            limit,
          );
          const cutoff = `utc_date < DATE_SUB(UTC_DATE(), INTERVAL 13 MONTH)`;
          removed += await this.deleteLimited(
            connection,
            'share_analytics_daily_viewers',
            cutoff,
            limit,
          );
          removed += await this.deleteLimited(
            connection,
            'share_analytics_daily_aggregates',
            cutoff,
            limit,
          );
          return removed;
        }),
      );
    } catch (error) {
      if (error instanceof TypeError) throw error;
      throw new ShareAnalyticsError('SERVICE_UNAVAILABLE');
    }
  }

  async purgeBoard(connection: PoolConnection, boardPk: bigint): Promise<void> {
    const board = boardPk.toString();
    const statements: readonly [string, readonly unknown[]][] = [
      [
        `DELETE r FROM share_analytics_replays r
         JOIN share_analytics_contexts c ON c.context_id = r.context_id
         WHERE c.board_pk = ?`,
        [board],
      ],
      [
        `DELETE p FROM share_analytics_context_pages p
         JOIN share_analytics_contexts c ON c.context_id = p.context_id
         WHERE c.board_pk = ?`,
        [board],
      ],
      ['DELETE FROM share_analytics_contexts WHERE board_pk = ?', [board]],
      ['DELETE FROM share_analytics_rolling_admissions WHERE board_pk = ?', [board]],
      ['DELETE FROM share_analytics_daily_viewers WHERE board_pk = ?', [board]],
      ['DELETE FROM share_analytics_daily_aggregates WHERE board_pk = ?', [board]],
      ['DELETE FROM share_analytics_lifetime_aggregates WHERE board_pk = ?', [board]],
    ];
    for (const [sql, parameters] of statements)
      await connection.execute<ResultSetHeader>(sql, parameters);
  }

  private async deleteLimited(
    connection: PoolConnection,
    table: string,
    predicate: string,
    limit: number,
  ): Promise<number> {
    const [result] = await connection.execute<ResultSetHeader>(
      `DELETE FROM ${table} WHERE ${predicate} LIMIT ${limit}`,
    );
    return result.affectedRows;
  }
}
