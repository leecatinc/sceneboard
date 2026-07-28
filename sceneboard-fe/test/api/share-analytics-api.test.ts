import assert from 'node:assert/strict';
import test from 'node:test';
import type { ShareAnalyticsContextV1 } from '@sceneboard/board-schema';

import {
  dispatchPublicShareAnalyticsEventV1,
  issuePublicShareAnalyticsContextV1,
  ShareAnalyticsApi,
} from '../../lib/share-analytics/share-analytics-api';
import type { SessionRequestCoordinator } from '../../lib/auth/renewal-singleflight';

const context = {
  viewContextId: 'view_context_1',
  revisionId: 'revision_1',
  publicationGeneration: 2,
  accessGeneration: 3,
  pageIds: ['page_1', 'page_2'],
  expiresAt: '2099-08-01T00:00:00.000Z',
  csrfToken: 'csrf-token-with-at-least-thirty-two-characters',
} as unknown as ShareAnalyticsContextV1;

test('public context issuance is credentialed and admits only the exact 201 contract', async () => {
  const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
  const result = await issuePublicShareAnalyticsContextV1({
    apiOrigin: 'https://api.sceneboard.test',
    shareId: 'share_1',
    fetcher: async (url, init) => {
      requests.push({ url: String(url), init });
      return new Response(JSON.stringify(context), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  assert.equal(result.kind, 'ok');
  assert.equal(
    requests[0]?.url,
    'https://api.sceneboard.test/api/v1/public/shares/share_1/view-contexts',
  );
  assert.equal(requests[0]?.init?.credentials, 'include');
  assert.equal(requests[0]?.init?.body, '{}');
});

test('event retry uses one intent identity and only the bounded 250/1000 schedule', async () => {
  const bodies: string[] = [];
  const delays: number[] = [];
  let calls = 0;
  const result = await dispatchPublicShareAnalyticsEventV1({
    apiOrigin: 'https://api.sceneboard.test',
    context,
    eventKind: 'first-visible',
    pageId: 'page_1',
    idempotencyKey: 'view_intent_00000001',
    signal: new AbortController().signal,
    isCurrent: () => true,
    retryWait: async (delay) => {
      delays.push(delay);
      return true;
    },
    fetcher: async (_url, init) => {
      calls += 1;
      bodies.push(String(init?.body));
      if (calls === 1) return new Response('{}', { status: 429, headers: { 'retry-after': '0' } });
      if (calls === 2) return new Response('{}', { status: 503 });
      return new Response(JSON.stringify({ status: 'counted', replayed: false }), { status: 202 });
    },
  });
  assert.deepEqual(result, {
    kind: 'complete',
    value: { status: 'counted', replayed: false },
  });
  assert.deepEqual(delays, [250, 1_000]);
  assert.equal(new Set(bodies).size, 1);
  assert.match(bodies[0]!, /"idempotencyKey":"view_intent_00000001"/u);
});

test('event completion distinguishes exact fresh/replay contracts and evicts only typed 404', async () => {
  for (const [status, body] of [
    [202, { status: 'deduped', replayed: false }],
    [200, { status: 'deduped', replayed: true }],
  ] as const) {
    const result = await dispatchPublicShareAnalyticsEventV1({
      apiOrigin: 'https://api.sceneboard.test',
      context,
      eventKind: 'page-visible',
      pageId: 'page_2',
      idempotencyKey: `view_intent_${status}_0000`,
      signal: new AbortController().signal,
      isCurrent: () => true,
      fetcher: async () => new Response(JSON.stringify(body), { status }),
    });
    assert.deepEqual(result, { kind: 'complete', value: body });
  }
  let calls = 0;
  const evicted = await dispatchPublicShareAnalyticsEventV1({
    apiOrigin: 'https://api.sceneboard.test',
    context,
    eventKind: 'page-visible',
    pageId: 'page_2',
    idempotencyKey: 'view_intent_evict_0001',
    signal: new AbortController().signal,
    isCurrent: () => true,
    retryWait: async () => true,
    fetcher: async () => {
      calls += 1;
      return new Response(
        JSON.stringify({
          error: {
            code: 'SHARE_VIEW_UNAVAILABLE',
            message: 'Unavailable',
            requestId: 'request_1',
          },
        }),
        { status: 404 },
      );
    },
  });
  assert.deepEqual(evicted, { kind: 'context_evicted' });
  assert.equal(calls, 1);
});

test('terminal statuses and stale or expired contexts never retry', async () => {
  for (const status of [400, 403, 409]) {
    let calls = 0;
    const result = await dispatchPublicShareAnalyticsEventV1({
      apiOrigin: 'https://api.sceneboard.test',
      context,
      eventKind: 'page-visible',
      pageId: 'page_1',
      idempotencyKey: `view_terminal_${status}_01`,
      signal: new AbortController().signal,
      isCurrent: () => true,
      retryWait: async () => {
        throw new TypeError('terminal response must not wait');
      },
      fetcher: async () => {
        calls += 1;
        return new Response('{}', { status });
      },
    });
    assert.deepEqual(result, { kind: 'discarded' });
    assert.equal(calls, 1);
  }
  for (const [current, now] of [
    [false, Date.now()],
    [true, Date.parse(context.expiresAt)],
  ] as const) {
    let calls = 0;
    const result = await dispatchPublicShareAnalyticsEventV1({
      apiOrigin: 'https://api.sceneboard.test',
      context,
      eventKind: 'page-visible',
      pageId: 'page_1',
      idempotencyKey: `view_stale_${String(current)}_01`,
      signal: new AbortController().signal,
      isCurrent: () => current,
      now: () => now,
      fetcher: async () => {
        calls += 1;
        return new Response('{}', { status: 503 });
      },
    });
    assert.deepEqual(result, { kind: 'discarded' });
    assert.equal(calls, 0);
  }
});

test('owner report uses the shared session coordinator and keeps forged 404 non-enumerating', async () => {
  const requests: Array<Record<string, unknown>> = [];
  const coordinator = {
    dispatchShared: async (request: Record<string, unknown>) => {
      requests.push(request);
      return {
        kind: 'ok',
        value: { response: new Response('{}', { status: 404 }), body: {} },
      };
    },
  } as unknown as SessionRequestCoordinator;
  const result = await new ShareAnalyticsApi(coordinator).report(
    'board_1',
    '2026-07-01',
    '2026-07-28',
  );
  assert.deepEqual(result, { kind: 'not_found' });
  assert.deepEqual(requests[0], {
    path: '/api/v1/boards/board_1/share-analytics?from=2026-07-01&to=2026-07-28',
    method: 'GET',
  });
});
