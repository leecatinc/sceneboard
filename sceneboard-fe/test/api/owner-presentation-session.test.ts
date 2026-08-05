import assert from 'node:assert/strict';
import test from 'node:test';
import type { PageId } from '@sceneboard/board-schema';

import { OwnerPresentationSessionApi } from '../../lib/api/owner-presentation-session';
import type { SessionRequestCoordinator } from '../../lib/auth/renewal-singleflight';

const pageId = 'page_1234567890123456789012' as PageId;
const sessionId = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const startedAt = '2026-08-05T06:00:00.000Z';
const snapshot = {
  sessionId,
  role: 'presenter' as const,
  status: 'active' as const,
  version: 0,
  currentPageId: pageId,
  annotation: { pageId, strokes: [] },
  startedAt,
  updatedAt: startedAt,
  expiresAt: '2026-08-05T08:00:00.000Z',
};

test('owner presentation uses the authenticated board route and CSRF for session creation', async () => {
  const requests: Array<Record<string, unknown>> = [];
  const coordinator = {
    currentSnapshot: () => ({ csrfToken: 'csrf-token' }),
    dispatchShared: async (request: Record<string, unknown>) => {
      requests.push(request);
      return {
        kind: 'ok',
        value: { response: new Response(null, { status: 201 }), body: snapshot },
      };
    },
  } as unknown as SessionRequestCoordinator;
  const api = new OwnerPresentationSessionApi(coordinator);
  assert.deepEqual(
    await api.start({
      apiOrigin: 'https://sceneboard.test',
      boardId: 'board_1234567890123456789012',
      revisionId: 'revision_1',
      currentPageId: pageId,
    }),
    snapshot,
  );
  assert.deepEqual(requests[0], {
    path: '/api/v1/boards/board_1234567890123456789012/presentation-sessions?revisionId=revision_1',
    method: 'POST',
    body: { currentPageId: pageId },
    csrfToken: 'csrf-token',
  });
  assert.equal(
    api.eventsUrl({
      apiOrigin: 'https://sceneboard.test',
      boardId: 'board_1234567890123456789012',
      revisionId: 'revision_1',
      sessionId,
    }),
    `https://sceneboard.test/api/v1/boards/board_1234567890123456789012/presentation-sessions/${sessionId}/events?revisionId=revision_1`,
  );
});
