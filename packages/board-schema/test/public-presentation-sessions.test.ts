import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  PublicPresentationEventParserV1,
  PublicPresentationStartRequestParserV1,
  PublicPresentationUpdateRequestParserV1,
} from '../src/index.js';

const pageId = 'page_1234567890123456789012';

test('public presentation contracts accept bounded full snapshots', () => {
  const update = PublicPresentationUpdateRequestParserV1.parse({
    expectedVersion: 3,
    currentPageId: pageId,
    annotation: {
      pageId,
      strokes: [
        {
          id: 'stroke-1',
          color: '#e5484d',
          width: 4,
          points: [
            { x: 0, y: 0 },
            { x: 1, y: 1 },
          ],
        },
      ],
    },
  });
  assert.equal(update.ok, true);
  assert.equal(PublicPresentationStartRequestParserV1.parse({ currentPageId: pageId }).ok, true);
});

test('public presentation contracts reject unknown and oversized state', () => {
  assert.equal(
    PublicPresentationStartRequestParserV1.parse({ currentPageId: pageId, role: 'presenter' }).ok,
    false,
  );
  assert.equal(
    PublicPresentationUpdateRequestParserV1.parse({
      expectedVersion: 0,
      currentPageId: pageId,
      annotation: {
        pageId,
        strokes: [
          {
            id: 'stroke-1',
            color: '#e5484d',
            width: 4,
            points: Array.from({ length: 129 }, () => ({ x: 0.5, y: 0.5 })),
          },
        ],
      },
    }).ok,
    false,
  );
});

test('public presentation event pins annotation to the selected page', () => {
  const sessionId = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  const timestamp = '2026-08-05T06:00:00.000Z';
  assert.equal(
    PublicPresentationEventParserV1.parse({
      type: 'presentation.state.v1',
      snapshot: {
        sessionId,
        role: 'viewer',
        status: 'active',
        version: 1,
        currentPageId: pageId,
        annotation: { pageId: 'page_abcdefghijklmnopqrstuv', strokes: [] },
        startedAt: timestamp,
        updatedAt: timestamp,
        expiresAt: '2026-08-05T08:00:00.000Z',
      },
    }).ok,
    false,
  );
});
