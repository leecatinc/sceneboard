import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PageIdParserV1 } from '@sceneboard/board-schema';

import {
  expandShareAnalyticsEvent,
  shareAnalyticsRollingAdmissionWins,
} from '../../src/share-analytics/event/share-analytics-event.service.js';

const pageId = PageIdParserV1.parse('page-a');
if (!pageId.ok) throw new Error('invalid test page ID');
const PAGE_ID = pageId.data.value;

test('uses one rolling thirty-minute boundary independent of half-hour and UTC rollover', () => {
  const last = new Date('2026-07-27T23:45:00.000Z');
  assert.equal(
    shareAnalyticsRollingAdmissionWins(last, new Date('2026-07-28T00:14:59.999Z')),
    false,
  );
  assert.equal(
    shareAnalyticsRollingAdmissionWins(last, new Date('2026-07-28T00:15:00.000Z')),
    true,
  );
  assert.equal(
    shareAnalyticsRollingAdmissionWins(last, new Date('2026-07-28T00:15:00.001Z')),
    true,
  );
});

test('expands request intent into the canonical board and stable-page dimensions', () => {
  const page = { pageOrdinal: 2, titleLabel: 'Summary' };
  assert.deepEqual(
    expandShareAnalyticsEvent({ eventKind: 'first-visible', pageId: PAGE_ID }, page),
    [
      {
        metricKind: 'board-open',
        pageDimension: '__BOARD__',
        pageOrdinal: null,
        titleLabel: null,
      },
      {
        metricKind: 'page-view',
        pageDimension: 'page-a',
        pageOrdinal: 2,
        titleLabel: 'Summary',
      },
    ],
  );
  assert.deepEqual(
    expandShareAnalyticsEvent({ eventKind: 'page-visible', pageId: PAGE_ID }, page),
    [
      {
        metricKind: 'page-view',
        pageDimension: 'page-a',
        pageOrdinal: 2,
        titleLabel: 'Summary',
      },
    ],
  );
});
