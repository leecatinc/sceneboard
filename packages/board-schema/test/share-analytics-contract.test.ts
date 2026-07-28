import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  SHARE_ANALYTICS_ERROR_CODES_V1,
  ShareAnalyticsContextRequestSchemaV1,
  ShareAnalyticsContextSchemaV1,
  ShareAnalyticsEventResultSchemaV1,
  ShareAnalyticsEventSchemaV1,
  ShareAnalyticsReportSchemaV1,
} from '../src/index.js';

const context = {
  viewContextId: 'view-context',
  revisionId: 'revision-1',
  publicationGeneration: 2,
  accessGeneration: 3,
  pageIds: ['page-a', 'page-b'],
  expiresAt: '2026-07-28T00:30:00.000Z',
  csrfToken: 'x'.repeat(32),
};

test('share analytics contracts accept only the closed context and event shapes', () => {
  assert.deepEqual(ShareAnalyticsContextRequestSchemaV1.parse({}), {});
  assert.equal(ShareAnalyticsContextRequestSchemaV1.safeParse({ extra: true }).success, false);
  assert.deepEqual(ShareAnalyticsContextSchemaV1.parse(context), context);
  assert.equal(
    ShareAnalyticsContextSchemaV1.safeParse({ ...context, pageIds: ['page-a', 'page-a'] }).success,
    false,
  );
  const event = {
    viewContextId: 'view-context',
    eventKind: 'first-visible',
    pageId: 'page-a',
    idempotencyKey: 'event-key-000001',
  };
  assert.deepEqual(ShareAnalyticsEventSchemaV1.parse(event), event);
  assert.equal(
    ShareAnalyticsEventSchemaV1.safeParse({ ...event, nodeId: 'node-a' }).success,
    false,
  );
  assert.deepEqual(
    ShareAnalyticsEventResultSchemaV1.parse({ status: 'counted', replayed: false }),
    {
      status: 'counted',
      replayed: false,
    },
  );
});

test('share analytics report validates date order, counts, page reach and unknown fields', () => {
  const report = {
    boardId: 'board-1',
    from: '2026-07-01',
    to: '2026-07-31',
    totals: {
      boardOpens: 4,
      pageViews: 7,
      estimatedDailyReach: 3,
      lastAggregatedAt: '2026-07-28T00:00:00.000Z',
    },
    publications: [
      {
        shareId: 'share-1',
        publicationGeneration: 3,
        revisionId: 'revision-1',
        boardOpens: 4,
        pageViews: 7,
        estimatedDailyReach: 3,
        lastAggregatedAt: '2026-07-28T00:00:00.000Z',
        pages: [
          {
            pageId: 'page-a',
            pageOrdinal: 0,
            titleLabel: 'Page A',
            pageViews: 2,
            pageReachBasisPoints: 5_000,
          },
        ],
      },
    ],
  };
  assert.deepEqual(ShareAnalyticsReportSchemaV1.parse(report), report);
  assert.equal(
    ShareAnalyticsReportSchemaV1.safeParse({ ...report, from: '2026-08-01' }).success,
    false,
  );
  assert.equal(
    ShareAnalyticsReportSchemaV1.safeParse({
      ...report,
      publications: [{ ...report.publications[0], unknown: true }],
    }).success,
    false,
  );
  assert.equal(SHARE_ANALYTICS_ERROR_CODES_V1.length, 8);
});
