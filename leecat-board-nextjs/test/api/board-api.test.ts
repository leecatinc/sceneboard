import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import type { IdempotencyKey, RequestId } from '@leecat-board/board-schema';

import { BoardApiClient } from '../../lib/api/board-api';
import {
  SessionRequestCoordinator,
  type GenerationStoragePort,
  type LockManagerPort,
} from '../../lib/auth/renewal-singleflight';

const generation = 'AAAAAAAAAAAAAAAAAAAAAA';
const session = {
  user: { userId: 'user_1', email: 'user@example.dev', createdAt: '2026-07-16T00:00:00.000Z' },
  session: { sessionId: 'session_1', idleExpiresAt: '2026-07-16T20:00:00.000Z', absoluteExpiresAt: '2026-07-23T12:00:00.000Z' },
  csrfToken: 'lcbcsrf_v1.s.binding.nonce.1800000000000.mac',
};

const fixture = (name: string): Record<string, unknown> => JSON.parse(readFileSync(new URL(`../../../packages/board-schema/test/fixtures/valid/${name}`, import.meta.url), 'utf8')) as Record<string, unknown>;

const setup = (operationFixture: string, expectedType: string, status = 200) => {
  const values = new Map<string, string>();
  const storage: GenerationStoragePort = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
  };
  const locks: LockManagerPort = { request: async (_name, _options, callback) => callback() };
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  let call = 0;
  const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(input), ...(init === undefined ? {} : { init }) });
    if (call++ === 0) return new Response(JSON.stringify(session), { status: 200, headers: { 'X-Auth-Generation': generation } });
    const url = new URL(String(input));
    const body = init?.body === undefined ? null : JSON.parse(String(init.body)) as Record<string, unknown>;
    const requestId = String(url.searchParams.get('requestId') ?? body?.requestId ?? '');
    const result: Record<string, unknown> = { ...fixture(operationFixture), requestId };
    assert.equal((result.result as { type: string }).type, expectedType);
    return new Response(JSON.stringify({
      protocolVersion: 1,
      type: 'board.http.success',
      requestId,
      result,
      metadata: { history: null },
    }), {
      status,
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Request-Id': requestId },
    });
  };
  const coordinator = new SessionRequestCoordinator('https://sceneboard.dev', {
    locks,
    storage,
    fetcher,
    randomBytes: () => new Uint8Array(16).fill(7),
  });
  return { coordinator, api: new BoardApiClient(coordinator), requests };
};

test('listBoards sends the closed D5 GET selector and admits a strict D6 envelope', async () => {
  const value = setup('operation-result-board-list.v1.json', 'board.list');
  assert.equal((await value.coordinator.reconcileSessionGeneration()).kind, 'ok');
  const result = await value.api.listBoards();
  assert.equal(result.kind, 'ok');
  if (result.kind !== 'ok') return;
  assert.equal(result.value.boards[0]?.title, 'Board');
  const request = value.requests[1];
  assert.equal(new URL(request?.url ?? '').pathname, '/api/v1/boards');
  assert.equal(new URL(request?.url ?? '').searchParams.get('limit'), '50');
  assert.equal(new URL(request?.url ?? '').searchParams.get('includeArchived'), 'false');
  assert.equal(request?.init?.method, 'GET');
  assert.equal(request?.init?.body, undefined);
});

test('createBoard preserves caller-owned retry identity and CSRF in the sole browser adapter', async () => {
  const value = setup('operation-result-board-create.v1.json', 'board.create');
  await value.coordinator.reconcileSessionGeneration();
  const result = await value.api.createBoard({
    title: 'Board',
    requestId: 'request_retry_1' as RequestId,
    idempotencyKey: 'idempotency.retry.0001' as IdempotencyKey,
    csrfToken: session.csrfToken,
  });
  assert.equal(result.kind, 'ok');
  const request = value.requests[1];
  assert.equal(request?.url, 'https://sceneboard.dev/api/v1/boards');
  assert.equal(request?.init?.method, 'POST');
  assert.equal((request?.init?.headers as Headers).get('X-CSRF-Token'), session.csrfToken);
  assert.deepEqual(JSON.parse(String(request?.init?.body)), {
    protocolVersion: 1,
    requestId: 'request_retry_1',
    type: 'board.create',
    idempotencyKey: 'idempotency.retry.0001',
    title: 'Board',
  });
});

test('renameBoard sends an owner CSRF request and accepts only the matching title projection', async () => {
  const values = new Map<string, string>();
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  let call = 0;
  const coordinator = new SessionRequestCoordinator('https://sceneboard.dev', {
    locks: { request: async (_name, _options, callback) => callback() },
    storage: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => { values.set(key, value); },
      removeItem: (key) => { values.delete(key); },
    },
    fetcher: async (input, init) => {
      requests.push({ url: String(input), ...(init === undefined ? {} : { init }) });
      if (call++ === 0) return new Response(JSON.stringify(session), { status: 200, headers: { 'X-Auth-Generation': generation } });
      return new Response(JSON.stringify({
        boardId: 'board_1',
        title: 'Launch plan',
        updatedAt: '2026-07-18T01:02:03.456Z',
      }), { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store, private' } });
    },
    randomBytes: () => new Uint8Array(16).fill(7),
  });
  await coordinator.reconcileSessionGeneration();

  const result = await new BoardApiClient(coordinator).renameBoard('board_1', 'Launch plan');

  assert.deepEqual(result, { kind: 'ok', value: {
    boardId: 'board_1',
    title: 'Launch plan',
    updatedAt: '2026-07-18T01:02:03.456Z',
  } });
  const request = requests[1];
  assert.equal(request?.url, 'https://sceneboard.dev/api/v1/boards/board_1/title');
  assert.equal(request?.init?.method, 'POST');
  assert.equal((request?.init?.headers as Headers).get('X-CSRF-Token'), session.csrfToken);
  assert.deepEqual(JSON.parse(String(request?.init?.body)), { title: 'Launch plan' });
});
