import assert from 'node:assert/strict';
import test from 'node:test';
import type { PageId } from '@sceneboard/board-schema';

import {
  endPublicPresentationSessionV1,
  parsePublicPresentationEventV1,
  publicPresentationEventsUrlV1,
  startPublicPresentationSessionV1,
  updatePublicPresentationSessionV1,
} from '../../lib/api/public-presentation-session';

const contextId = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const sessionId = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const pageId = 'page_1234567890123456789012' as PageId;
const startedAt = '2026-08-05T06:00:00.000Z';

const snapshot = (version: number) => ({
  sessionId,
  role: 'presenter',
  status: 'active',
  version,
  currentPageId: pageId,
  annotation: { pageId, strokes: [] },
  startedAt,
  updatedAt: startedAt,
  expiresAt: '2026-08-05T08:00:00.000Z',
});

test('public live presentation mutations are credentialed, exact, and versioned', async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
  let responseBody: unknown = snapshot(0);
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), init });
    return new Response(JSON.stringify(responseBody), {
      status: init?.body === '{}' ? 200 : requests.length === 1 ? 201 : 200,
    });
  };
  try {
    await startPublicPresentationSessionV1({
      apiOrigin: 'https://api.sceneboard.test',
      contextId,
      currentPageId: pageId,
    });
    responseBody = snapshot(1);
    await updatePublicPresentationSessionV1({
      apiOrigin: 'https://api.sceneboard.test',
      contextId,
      sessionId,
      update: {
        expectedVersion: 0,
        currentPageId: pageId,
        annotation: { pageId, strokes: [] },
      },
    });
    responseBody = { sessionId, status: 'ended' };
    await endPublicPresentationSessionV1({
      apiOrigin: 'https://api.sceneboard.test',
      contextId,
      sessionId,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(requests.length, 3);
  for (const request of requests) {
    assert.equal(request.init?.credentials, 'include');
    assert.equal(request.init?.cache, 'no-store');
    assert.equal(request.init?.redirect, 'error');
  }
  assert.equal(
    requests[0]?.url,
    `https://api.sceneboard.test/api/v1/public/share-contexts/${contextId}/presentation-sessions`,
  );
  assert.match(String(requests[1]?.init?.body), /"expectedVersion":0/u);
  assert.equal(
    requests[2]?.url,
    `https://api.sceneboard.test/api/v1/public/share-contexts/${contextId}/presentation-sessions/${sessionId}/end`,
  );
});

test('public live presentation events accept only the closed state envelope', () => {
  assert.equal(
    publicPresentationEventsUrlV1({
      apiOrigin: 'https://api.sceneboard.test',
      contextId,
      sessionId,
    }),
    `https://api.sceneboard.test/api/v1/public/share-contexts/${contextId}/presentation-sessions/${sessionId}/events`,
  );
  assert.deepEqual(
    parsePublicPresentationEventV1(
      JSON.stringify({ type: 'presentation.state.v1', snapshot: snapshot(4) }),
    ),
    snapshot(4),
  );
  assert.equal(
    parsePublicPresentationEventV1(
      JSON.stringify({ type: 'presentation.state.v1', snapshot: snapshot(4), secret: 'x' }),
    ),
    null,
  );
  assert.equal(parsePublicPresentationEventV1('{'), null);
});
