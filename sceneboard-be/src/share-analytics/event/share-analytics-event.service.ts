import {
  ShareAnalyticsEventResultParserV1,
  type ShareAnalyticsEventResultV1,
  type ShareAnalyticsEventV1,
} from '@sceneboard/board-schema';
import type { PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';

import { ShareAnalyticsError } from '../../common/errors/share-analytics.error.js';
import type { CryptoService } from '../../common/security/crypto.service.js';
import { formatPublicUuidV4 } from '../../common/ids/public-uuid.storage.js';
import { parseMysqlTimestampUtc } from '../../common/time/mysql-timestamp.js';
import type { MysqlService } from '../../database/mysql.service.js';
import { withTransaction } from '../../database/transaction.js';
import { ViewerIdentityService } from '../context/viewer-identity.service.js';

interface ContextRow extends RowDataPacket {
  boardPk: string;
  sharePk: string;
  revisionPk: string;
  revisionId: Buffer;
  publicationGeneration: string;
  accessGeneration: string;
  expiresAt: string;
  pageOrdinal: number;
  titleLabel: string;
}

interface ClockRow extends RowDataPacket {
  transactionNow: string;
  utcDate: string;
}

interface ReplayRow extends RowDataPacket {
  eventKind: string;
  pageId: string;
  outcome: string;
}

interface AdmissionRow extends RowDataPacket {
  lastCountedAt: string;
}

type MetricCandidate = {
  metricKind: 'board-open' | 'page-view';
  pageDimension: string;
  pageOrdinal: number | null;
  titleLabel: string | null;
};

export const shareAnalyticsRollingAdmissionWins = (
  lastCountedAt: Date,
  serverTime: Date,
): boolean => serverTime.valueOf() >= lastCountedAt.valueOf() + 30 * 60 * 1_000;

export const expandShareAnalyticsEvent = (
  event: Pick<ShareAnalyticsEventV1, 'eventKind' | 'pageId'>,
  page: { pageOrdinal: number; titleLabel: string },
): readonly MetricCandidate[] =>
  event.eventKind === 'first-visible'
    ? [
        {
          metricKind: 'board-open',
          pageDimension: '__BOARD__',
          pageOrdinal: null,
          titleLabel: null,
        },
        {
          metricKind: 'page-view',
          pageDimension: event.pageId,
          pageOrdinal: page.pageOrdinal,
          titleLabel: page.titleLabel,
        },
      ]
    : [
        {
          metricKind: 'page-view',
          pageDimension: event.pageId,
          pageOrdinal: page.pageOrdinal,
          titleLabel: page.titleLabel,
        },
      ];

const positive = (value: string): number => {
  if (!/^[1-9][0-9]{0,15}$/u.test(value)) throw new ShareAnalyticsError('SERVICE_UNAVAILABLE');
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new ShareAnalyticsError('SERVICE_UNAVAILABLE');
  return parsed;
};

export class ShareAnalyticsEventService {
  private readonly identities: ViewerIdentityService;

  constructor(
    private readonly mysql: MysqlService,
    crypto: CryptoService,
  ) {
    this.identities = new ViewerIdentityService(crypto);
  }

  async admit(input: {
    event: ShareAnalyticsEventV1;
    cookieHeader?: string | undefined;
    csrfHeader?: string | undefined;
  }): Promise<{ statusCode: 200 | 202; result: ShareAnalyticsEventResultV1 }> {
    const seed = this.identities.require(input.cookieHeader);
    this.identities.assertCsrf({
      cookieHeader: input.cookieHeader,
      header: input.csrfHeader,
      seed,
      contextId: input.event.viewContextId,
      now: new Date(),
    });
    try {
      return await this.mysql.withConnection((connection) =>
        withTransaction(connection, 'READ COMMITTED', async () => {
          const clock = await this.clock(connection);
          const context = await this.lockContext(connection, input.event, clock.transactionNow);
          const derivatives = this.identities.derivatives({
            seed,
            contextId: input.event.viewContextId,
            utcDate: clock.utcDate,
          });
          const replay = await this.claimReplay(connection, {
            event: input.event,
            replayFamilyKey: derivatives.replayFamilyKey,
            nowSql: clock.transactionNow,
          });
          if (replay !== null) {
            const parsed = ShareAnalyticsEventResultParserV1.parse({
              status: replay,
              replayed: true,
            });
            if (!parsed.ok) throw new ShareAnalyticsError('SERVICE_UNAVAILABLE');
            return { statusCode: 200 as const, result: parsed.data.value };
          }
          const candidates = expandShareAnalyticsEvent(input.event, context);
          let counted = false;
          for (const candidate of candidates) {
            const admitted = await this.claimRollingAdmission(connection, {
              context,
              candidate,
              viewerDedupeKey: derivatives.viewerDedupeKey,
              nowSql: clock.transactionNow,
            });
            if (!admitted) continue;
            counted = true;
            await this.incrementAggregates(connection, {
              context,
              candidate,
              viewerDailyKey: derivatives.viewerDailyKey,
              utcDate: clock.utcDate,
              nowSql: clock.transactionNow,
            });
          }
          const outcome = counted ? 'counted' : 'deduped';
          const [updated] = await connection.execute<ResultSetHeader>(
            `UPDATE share_analytics_replays
             SET outcome = ?
             WHERE replay_family_key = ? AND context_id = ? AND idempotency_key = ?`,
            [
              outcome,
              derivatives.replayFamilyKey,
              input.event.viewContextId,
              input.event.idempotencyKey,
            ],
          );
          if (updated.affectedRows !== 1) throw new ShareAnalyticsError('SERVICE_UNAVAILABLE');
          const parsed = ShareAnalyticsEventResultParserV1.parse({
            status: outcome,
            replayed: false,
          });
          if (!parsed.ok) throw new ShareAnalyticsError('SERVICE_UNAVAILABLE');
          return { statusCode: 202 as const, result: parsed.data.value };
        }),
      );
    } catch (error) {
      if (error instanceof ShareAnalyticsError) throw error;
      throw new ShareAnalyticsError('SERVICE_UNAVAILABLE');
    } finally {
      seed.fill(0);
    }
  }

  private async clock(connection: PoolConnection): Promise<{
    transactionNow: string;
    utcDate: string;
  }> {
    const [rows] = await connection.query<ClockRow[]>(
      `SELECT UTC_TIMESTAMP(3) AS transactionNow,
              DATE_FORMAT(UTC_DATE(), '%Y-%m-%d') AS utcDate`,
    );
    const row = rows[0];
    if (rows.length !== 1 || row === undefined || !/^\d{4}-\d{2}-\d{2}$/u.test(row.utcDate))
      throw new ShareAnalyticsError('SERVICE_UNAVAILABLE');
    parseMysqlTimestampUtc(row.transactionNow);
    return row;
  }

  private async lockContext(
    connection: PoolConnection,
    event: ShareAnalyticsEventV1,
    nowSql: string,
  ): Promise<{
    boardPk: string;
    sharePk: string;
    revisionPk: string;
    revisionId: string;
    publicationGeneration: number;
    accessGeneration: number;
    pageOrdinal: number;
    titleLabel: string;
  }> {
    const [rows] = await connection.execute<ContextRow[]>(
      `SELECT CAST(c.board_pk AS CHAR) AS boardPk,
              CAST(c.share_pk AS CHAR) AS sharePk,
              CAST(c.revision_pk AS CHAR) AS revisionPk,
              r.revision_id AS revisionId,
              CAST(c.publication_generation AS CHAR) AS publicationGeneration,
              CAST(c.access_generation AS CHAR) AS accessGeneration,
              c.expires_at AS expiresAt, p.page_ordinal AS pageOrdinal,
              p.title_label AS titleLabel
       FROM share_analytics_contexts c
       JOIN share_analytics_context_pages p
         ON p.context_id = c.context_id AND p.page_id = ?
       JOIN board_shares s ON s.share_pk = c.share_pk
       JOIN boards b ON b.board_pk = c.board_pk
       JOIN board_revisions r
         ON r.board_pk = c.board_pk AND r.revision_pk = c.revision_pk
       WHERE c.context_id = ?
         AND c.expires_at > ?
         AND s.status = 'active'
         AND s.board_pk = c.board_pk
         AND s.pinned_revision_pk = c.revision_pk
         AND s.publication_generation = c.publication_generation
         AND s.access_generation = c.access_generation
         AND b.archived_at IS NULL
       LIMIT 1 FOR UPDATE`,
      [event.pageId, event.viewContextId, nowSql],
    );
    const row = rows[0];
    if (rows.length !== 1 || row === undefined)
      throw new ShareAnalyticsError('SHARE_VIEW_UNAVAILABLE');
    if (!Number.isInteger(row.pageOrdinal) || row.pageOrdinal < 0 || row.titleLabel.length === 0)
      throw new ShareAnalyticsError('SERVICE_UNAVAILABLE');
    return {
      boardPk: row.boardPk,
      sharePk: row.sharePk,
      revisionPk: row.revisionPk,
      revisionId: formatPublicUuidV4(row.revisionId),
      publicationGeneration: positive(row.publicationGeneration),
      accessGeneration: positive(row.accessGeneration),
      pageOrdinal: row.pageOrdinal,
      titleLabel: row.titleLabel,
    };
  }

  private async claimReplay(
    connection: PoolConnection,
    input: {
      event: ShareAnalyticsEventV1;
      replayFamilyKey: Buffer;
      nowSql: string;
    },
  ): Promise<'counted' | 'deduped' | null> {
    const [claim] = await connection.execute<ResultSetHeader>(
      `INSERT IGNORE INTO share_analytics_replays (
         replay_family_key, context_id, idempotency_key, event_kind, page_id,
         outcome, created_at, expires_at
       ) VALUES (?, ?, ?, ?, ?, 'deduped', ?, DATE_ADD(?, INTERVAL 48 HOUR))`,
      [
        input.replayFamilyKey,
        input.event.viewContextId,
        input.event.idempotencyKey,
        input.event.eventKind,
        input.event.pageId,
        input.nowSql,
        input.nowSql,
      ],
    );
    if (claim.affectedRows === 1) return null;
    const [rows] = await connection.execute<ReplayRow[]>(
      `SELECT event_kind AS eventKind, page_id AS pageId, outcome
       FROM share_analytics_replays
       WHERE replay_family_key = ? AND context_id = ? AND idempotency_key = ?
       LIMIT 1 FOR UPDATE`,
      [input.replayFamilyKey, input.event.viewContextId, input.event.idempotencyKey],
    );
    const row = rows[0];
    if (rows.length !== 1 || row === undefined)
      throw new ShareAnalyticsError('SERVICE_UNAVAILABLE');
    if (row.eventKind !== input.event.eventKind || row.pageId !== input.event.pageId)
      throw new ShareAnalyticsError('IDEMPOTENCY_KEY_REUSED');
    if (row.outcome !== 'counted' && row.outcome !== 'deduped')
      throw new ShareAnalyticsError('SERVICE_UNAVAILABLE');
    return row.outcome;
  }

  private async claimRollingAdmission(
    connection: PoolConnection,
    input: {
      context: {
        boardPk: string;
        sharePk: string;
        revisionPk: string;
        publicationGeneration: number;
        accessGeneration: number;
      };
      candidate: MetricCandidate;
      viewerDedupeKey: Buffer;
      nowSql: string;
    },
  ): Promise<boolean> {
    const identity = [
      input.viewerDedupeKey,
      input.context.sharePk,
      input.context.boardPk,
      input.context.revisionPk,
      input.context.publicationGeneration,
      input.context.accessGeneration,
      input.candidate.metricKind,
      input.candidate.pageDimension,
    ] as const;
    await connection.execute<ResultSetHeader>(
      `INSERT INTO share_analytics_rolling_admissions (
         viewer_dedupe_key, share_pk, board_pk, revision_pk, publication_generation,
         access_generation, metric_kind, page_dimension, last_counted_at, expires_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, DATE_SUB(?, INTERVAL 30 MINUTE),
                 DATE_ADD(?, INTERVAL 48 HOUR))
       ON DUPLICATE KEY UPDATE viewer_dedupe_key = VALUES(viewer_dedupe_key)`,
      [...identity, input.nowSql, input.nowSql],
    );
    const [rows] = await connection.execute<AdmissionRow[]>(
      `SELECT last_counted_at AS lastCountedAt
       FROM share_analytics_rolling_admissions
       WHERE viewer_dedupe_key = ? AND share_pk = ? AND board_pk = ? AND revision_pk = ?
         AND publication_generation = ? AND access_generation = ?
         AND metric_kind = ? AND page_dimension = ?
       LIMIT 1 FOR UPDATE`,
      [...identity],
    );
    const row = rows[0];
    if (rows.length !== 1 || row === undefined)
      throw new ShareAnalyticsError('SERVICE_UNAVAILABLE');
    const admitted = shareAnalyticsRollingAdmissionWins(
      parseMysqlTimestampUtc(row.lastCountedAt),
      parseMysqlTimestampUtc(input.nowSql),
    );
    if (!admitted) return false;
    const [updated] = await connection.execute<ResultSetHeader>(
      `UPDATE share_analytics_rolling_admissions
       SET last_counted_at = ?, expires_at = DATE_ADD(?, INTERVAL 48 HOUR)
       WHERE viewer_dedupe_key = ? AND share_pk = ? AND board_pk = ? AND revision_pk = ?
         AND publication_generation = ? AND access_generation = ?
         AND metric_kind = ? AND page_dimension = ?`,
      [input.nowSql, input.nowSql, ...identity],
    );
    if (updated.affectedRows !== 1) throw new ShareAnalyticsError('SERVICE_UNAVAILABLE');
    return true;
  }

  private async incrementAggregates(
    connection: PoolConnection,
    input: {
      context: {
        boardPk: string;
        sharePk: string;
        revisionPk: string;
        publicationGeneration: number;
      };
      candidate: MetricCandidate;
      viewerDailyKey: Buffer;
      utcDate: string;
      nowSql: string;
    },
  ): Promise<void> {
    await connection.execute<ResultSetHeader>(
      `INSERT IGNORE INTO share_analytics_daily_viewers (
         viewer_daily_key, board_pk, share_pk, revision_pk, publication_generation,
         \`utc_date\`, first_seen_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        input.viewerDailyKey,
        input.context.boardPk,
        input.context.sharePk,
        input.context.revisionPk,
        input.context.publicationGeneration,
        input.utcDate,
        input.nowSql,
      ],
    );
    const dimensions = [
      input.context.boardPk,
      input.context.sharePk,
      input.context.revisionPk,
      input.context.publicationGeneration,
      input.candidate.metricKind,
      input.candidate.pageDimension,
      input.candidate.pageOrdinal,
      input.candidate.titleLabel,
    ] as const;
    const [daily] = await connection.execute<ResultSetHeader>(
      `INSERT INTO share_analytics_daily_aggregates (
         board_pk, share_pk, revision_pk, publication_generation, \`utc_date\`,
         metric_kind, page_dimension, page_ordinal, title_label, metric_count,
         last_aggregated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
       ON DUPLICATE KEY UPDATE
         metric_count = metric_count + 1,
         page_ordinal = VALUES(page_ordinal),
         title_label = VALUES(title_label),
         last_aggregated_at = VALUES(last_aggregated_at)`,
      [
        input.context.boardPk,
        input.context.sharePk,
        input.context.revisionPk,
        input.context.publicationGeneration,
        input.utcDate,
        input.candidate.metricKind,
        input.candidate.pageDimension,
        input.candidate.pageOrdinal,
        input.candidate.titleLabel,
        input.nowSql,
      ],
    );
    const [lifetime] = await connection.execute<ResultSetHeader>(
      `INSERT INTO share_analytics_lifetime_aggregates (
         board_pk, share_pk, revision_pk, publication_generation,
         metric_kind, page_dimension, page_ordinal, title_label, metric_count,
         last_aggregated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
       ON DUPLICATE KEY UPDATE
         metric_count = metric_count + 1,
         page_ordinal = VALUES(page_ordinal),
         title_label = VALUES(title_label),
         last_aggregated_at = VALUES(last_aggregated_at)`,
      [...dimensions, input.nowSql],
    );
    if (daily.affectedRows < 1 || lifetime.affectedRows < 1)
      throw new ShareAnalyticsError('SERVICE_UNAVAILABLE');
  }
}
