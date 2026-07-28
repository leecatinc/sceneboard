import assert from 'node:assert/strict';
import test from 'node:test';
import type { PageCursorV1, RevisionId } from '@sceneboard/board-schema';
import type {
  NormalizedRetainedHistoryResultV1,
  NormalizedRetainedHistoryRowV1,
} from '@sceneboard/board-sdk/client';

import {
  historySettlementIsCurrentV1,
  mergeHistoryPageV1,
  type HistoryRequestIdentityV1,
} from '../../lib/board/history-selection';

const ids = {
  r40: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' as RevisionId,
  r39: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' as RevisionId,
  r38: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' as RevisionId,
};
const cursor1 = 'cursor_1' as PageCursorV1;
const cursor2 = 'cursor_2' as PageCursorV1;

const row = (revisionId: RevisionId, revisionNumber: number): NormalizedRetainedHistoryRowV1 => ({
  revisionId,
  revisionNumber,
  createdAt: `2026-07-28T00:00:${String(40 - revisionNumber).padStart(2, '0')}.000Z`,
  label: `Revision ${revisionNumber}`,
  actorLabel: 'editor',
  summary: 'Scene updated',
  schemaVersion: '2.0.0',
  previous: null,
  nextRevisionId: null,
});

const page = (
  rows: NormalizedRetainedHistoryRowV1[],
  nextCursor: PageCursorV1 | null,
): NormalizedRetainedHistoryResultV1 => ({
  source: 'history.retained-metadata',
  rows,
  boundary: { truncatedBefore: true, oldestRetainedRevisionId: ids.r38 },
  nextCursor,
  latest: { revisionId: ids.r40, revisionNumber: 40 },
});

test('appends exact overlaps once and preserves newest-first retained order', () => {
  const first = mergeHistoryPageV1(null, page([row(ids.r40, 40), row(ids.r39, 39)], cursor1), null);
  const second = mergeHistoryPageV1(
    first,
    page([row(ids.r39, 39), row(ids.r38, 38)], null),
    cursor1,
  );

  assert.deepEqual(
    second.rows.map((item) => item.revisionNumber),
    [40, 39, 38],
  );
  assert.deepEqual(second.seenCursors, [cursor1]);
  assert.equal(second.nextCursor, null);
});

test('rejects changed overlaps, order regression, mismatched and repeated cursors', () => {
  const first = mergeHistoryPageV1(null, page([row(ids.r40, 40), row(ids.r39, 39)], cursor1), null);
  assert.throws(() =>
    mergeHistoryPageV1(
      first,
      page([{ ...row(ids.r39, 39), summary: 'Scene cleared' }], null),
      cursor1,
    ),
  );
  assert.throws(() => mergeHistoryPageV1(first, page([row(ids.r38, 41)], null), cursor1));
  assert.throws(() => mergeHistoryPageV1(first, page([row(ids.r38, 38)], null), cursor2));
  assert.throws(() => mergeHistoryPageV1(first, page([row(ids.r38, 38)], cursor1), cursor1));
});

test('admits only the exact current request identity and rejects abort-loses-race settlements', () => {
  const controller = new AbortController();
  const identity: HistoryRequestIdentityV1 = {
    boardId: 'board_1',
    routeKey: 'board_1',
    selectionEpoch: 3,
    pageEpoch: 5,
    kind: 'list',
    cursor: cursor1,
    revisionId: null,
    controller,
  };
  assert.equal(historySettlementIsCurrentV1(identity, identity), true);
  assert.equal(historySettlementIsCurrentV1(identity, { ...identity, pageEpoch: 6 }), false);
  controller.abort();
  assert.equal(historySettlementIsCurrentV1(identity, identity), false);
});
