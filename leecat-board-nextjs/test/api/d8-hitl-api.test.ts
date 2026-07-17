import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import type {
  BoardId,
  HitlRequestId,
  IdempotencyKey,
  RequestId,
  RevisionId,
  TimestampV1,
} from '@leecat-board/board-schema';

import { BoardApiClient } from '../../lib/api/board-api';
import { SessionRequestCoordinator, type GenerationStoragePort, type LockManagerPort } from '../../lib/auth/renewal-singleflight';

const generation = 'AAAAAAAAAAAAAAAAAAAAAA';
const session = {
  user: { userId: 'user_1', email: 'user@example.dev', createdAt: '2026-07-16T00:00:00.000Z' },
  session: { sessionId: 'session_1', idleExpiresAt: '2026-07-16T20:00:00.000Z', absoluteExpiresAt: '2026-07-23T12:00:00.000Z' },
  csrfToken: 'lcbcsrf_v1.s.binding.nonce.1800000000000.mac',
};
const boardId = 'board_1' as BoardId;
const hitlRequestId = 'hitl_1' as HitlRequestId;
const revisionId = 'revision_1' as RevisionId;
const requestId = 'request_1' as RequestId;
const idempotencyKey = 'idempotency-key-1' as IdempotencyKey;
const stateUpdatedAt = '2026-07-16T00:00:00.000Z' as TimestampV1;

const fixture = (name: string): Record<string, unknown> => JSON.parse(readFileSync(new URL(`../../../packages/board-schema/test/fixtures/valid/${name}`, import.meta.url), 'utf8')) as Record<string, unknown>;

const setup = (respond: (url: URL, init: RequestInit | undefined) => Response) => {
  const values = new Map<string, string>();
  const storage: GenerationStoragePort = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
  };
  const locks: LockManagerPort = { request: async (_name, _options, callback) => callback() };
  const requests: Array<{ url: URL; init?: RequestInit }> = [];
  let first = true;
  const coordinator = new SessionRequestCoordinator('https://sceneboard.dev', {
    locks,
    storage,
    randomBytes: () => new Uint8Array(16),
    fetcher: async (value, init) => {
      if (first) {
        first = false;
        return new Response(JSON.stringify(session), { status: 200, headers: { 'X-Auth-Generation': generation } });
      }
      const url = new URL(String(value));
      requests.push({ url, ...(init === undefined ? {} : { init }) });
      return respond(url, init);
    },
  });
  return { coordinator, api: new BoardApiClient(coordinator), requests };
};

const success = (requestIdValue: string, result: Record<string, unknown>, status = 200): Response => new Response(JSON.stringify({
  protocolVersion: 1,
  type: 'board.http.success',
  requestId: requestIdValue,
  result: { ...result, requestId: requestIdValue },
  metadata: { history: null },
}), {
  status,
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Request-Id': requestIdValue },
});

test('respond selector preserves exact retry identity, CSRF, and typed response', async () => {
  const value = setup((_url, init) => success(requestId, fixture('mutation-result-hitl-respond.v1.json')));
  await value.coordinator.reconcileSessionGeneration();
  const result = await value.api.respondToInteraction({
    protocolVersion: 1,
    requestId,
    idempotencyKey,
    boardId,
    expectedRevisionId: revisionId,
    command: { type: 'hitl.respond', hitlRequestId, response: { kind: 'info', acknowledged: true } },
  });
  assert.equal(result.kind, 'ok');
  const sent = value.requests[0];
  assert.equal(sent?.url.pathname, '/api/v1/boards/board_1/mutations');
  assert.equal(sent?.init?.method, 'POST');
  assert.equal((sent?.init?.headers as Headers).get('X-CSRF-Token'), session.csrfToken);
  assert.deepEqual(JSON.parse(String(sent?.init?.body)), {
    protocolVersion: 1,
    requestId,
    idempotencyKey,
    boardId,
    expectedRevisionId: revisionId,
    command: { type: 'hitl.respond', hitlRequestId, response: { kind: 'info', acknowledged: true } },
  });
});

test('request selector preserves the immutable interaction definition', async () => {
  const value = setup(() => success(requestId, fixture('mutation-result-hitl-request.v1.json')));
  await value.coordinator.reconcileSessionGeneration();
  const result = await value.api.requestInteraction({
    protocolVersion: 1,
    requestId,
    idempotencyKey,
    boardId,
    expectedRevisionId: revisionId,
    command: {
      type: 'hitl.request',
      hitlRequestId,
      request: { kind: 'info', title: 'Information', body: 'Read this.', acknowledgeLabel: 'OK' },
    },
  });
  assert.equal(result.kind, 'ok');
  const body = JSON.parse(String(value.requests[0]?.init?.body)) as { command: unknown };
  assert.deepEqual(body.command, {
    type: 'hitl.request',
    hitlRequestId,
    request: { kind: 'info', title: 'Information', body: 'Read this.', acknowledgeLabel: 'OK' },
  });
});

test('read selector encodes exact bounded wait cursor and correlates interaction ID', async () => {
  const value = setup((url) => success(url.searchParams.get('requestId') ?? '', fixture('operation-result-hitl-read.v1.json')));
  await value.coordinator.reconcileSessionGeneration();
  const result = await value.api.readInteraction({
    protocolVersion: 1,
    requestId,
    type: 'hitl.read',
    boardId,
    hitlRequestId,
    wait: { afterStateUpdatedAt: stateUpdatedAt, timeoutMs: 30_000 },
  });
  assert.equal(result.kind, 'ok');
  const sent = value.requests[0];
  assert.equal(sent?.url.pathname, '/api/v1/boards/board_1/interactions/hitl_1');
  assert.equal(sent?.url.searchParams.get('afterStateUpdatedAt'), stateUpdatedAt);
  assert.equal(sent?.url.searchParams.get('timeoutMs'), '30000');
  assert.equal(sent?.init?.method, 'GET');
  assert.equal(sent?.init?.body, undefined);
});

test('cancel selector validates the lifecycle terminal result', async () => {
  const cancelled = fixture('hitl-interaction-cancelled.v1.json');
  const value = setup(() => new Response(JSON.stringify({
    protocolVersion: 1,
    type: 'hitl.lifecycle.result',
    requestId,
    boardId,
    action: 'cancel',
    replayed: false,
    eventIds: ['event_1'],
    hitl: cancelled,
  }), { status: 200, headers: {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Request-Id': requestId,
  } }));
  await value.coordinator.reconcileSessionGeneration();
  const result = await value.api.cancelInteraction(boardId, hitlRequestId, {
    protocolVersion: 1,
    requestId,
    expectedRevisionId: revisionId,
    expectedStateUpdatedAt: stateUpdatedAt,
  });
  assert.equal(result.kind, 'ok');
  if (result.kind === 'ok') assert.equal(result.value.hitl.state, 'cancelled');
  assert.equal(value.requests[0]?.url.pathname, '/api/v1/boards/board_1/interactions/hitl_1/cancel');
});

test('supersede selector carries the exact successor and validates terminal correlation', async () => {
  const superseded = fixture('hitl-interaction-superseded.v1.json');
  const value = setup((_url, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    assert.equal(body.successorHitlRequestId, 'hitl_2');
    return new Response(JSON.stringify({
      protocolVersion: 1,
      type: 'hitl.lifecycle.result',
      requestId,
      boardId,
      action: 'supersede',
      replayed: false,
      eventIds: ['event_1'],
      hitl: superseded,
    }), { status: 200, headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Request-Id': requestId,
    } });
  });
  await value.coordinator.reconcileSessionGeneration();
  const result = await value.api.supersedeInteraction(boardId, hitlRequestId, {
    protocolVersion: 1,
    requestId,
    expectedRevisionId: revisionId,
    expectedStateUpdatedAt: stateUpdatedAt,
    successorHitlRequestId: 'hitl_2' as HitlRequestId,
  });
  assert.equal(result.kind, 'ok');
  assert.equal(value.requests[0]?.url.pathname, '/api/v1/boards/board_1/interactions/hitl_1/supersede');
});

test('lifecycle adapter rejects duplicate response members and extra request members', async () => {
  const cancelled = JSON.stringify(fixture('hitl-interaction-cancelled.v1.json'));
  const value = setup(() => new Response(`{"protocolVersion":1,"type":"hitl.lifecycle.result","requestId":"request_1","boardId":"board_1","action":"cancel","action":"cancel","replayed":false,"eventIds":["event_1"],"hitl":${cancelled}}`, {
    status: 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Request-Id': requestId },
  }));
  await value.coordinator.reconcileSessionGeneration();
  const corrupt = await value.api.cancelInteraction(boardId, hitlRequestId, {
    protocolVersion: 1, requestId, expectedRevisionId: revisionId, expectedStateUpdatedAt: stateUpdatedAt,
  });
  assert.equal(corrupt.kind, 'corrupt_response');
  await assert.rejects(value.api.cancelInteraction(boardId, hitlRequestId, {
    protocolVersion: 1, requestId, expectedRevisionId: revisionId, expectedStateUpdatedAt: stateUpdatedAt,
    extra: true,
  } as never), /invalid hitl cancel request/u);
});
