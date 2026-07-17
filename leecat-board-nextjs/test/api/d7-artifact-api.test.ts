import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import type { ArtifactReferenceV1 } from '@leecat-board/board-schema';

import { BoardApiClient } from '../../lib/api/board-api';
import { SessionRequestCoordinator, type GenerationStoragePort, type LockManagerPort } from '../../lib/auth/renewal-singleflight';

const generation = 'AAAAAAAAAAAAAAAAAAAAAA';
const artifact = { artifactId: 'artifact_1', versionId: 'version_1' } as ArtifactReferenceV1;
const session = {
  user: { userId: 'user_1', email: 'user@example.dev', createdAt: '2026-07-16T00:00:00.000Z' },
  session: { sessionId: 'session_1', idleExpiresAt: '2026-07-16T20:00:00.000Z', absoluteExpiresAt: '2026-07-23T12:00:00.000Z' },
  csrfToken: 'lcbcsrf_v1.s.binding.nonce.1800000000000.mac',
};

const fixture = (): Record<string, unknown> => JSON.parse(readFileSync(new URL('../../../packages/board-schema/test/fixtures/valid/operation-result-artifact-get.v1.json', import.meta.url), 'utf8')) as Record<string, unknown>;

const setup = (response: (url: URL, init: RequestInit | undefined) => Response) => {
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
      return response(url, init);
    },
  });
  return { coordinator, api: new BoardApiClient(coordinator), requests };
};

test('artifact metadata selector correlates request, pair, and strict operation result', async () => {
  const value = setup((url) => {
    const requestId = url.searchParams.get('requestId') ?? '';
    const operation = { ...fixture(), requestId };
    return new Response(JSON.stringify({
      protocolVersion: 1,
      type: 'board.http.success',
      requestId,
      result: operation,
      metadata: { history: null },
    }), { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Request-Id': requestId } });
  });
  await value.coordinator.reconcileSessionGeneration();
  const result = await value.api.getArtifact('board_1', artifact);
  assert.equal(result.kind, 'ok');
  assert.equal(value.requests[0]?.url.pathname, '/api/v1/boards/board_1/artifacts/artifact_1/versions/version_1');
  assert.equal(value.requests[0]?.init?.method, 'GET');
});

test('artifact package consumes bounded binary bytes under the shared cookie lease', async () => {
  const packageBytes = new Uint8Array(14);
  packageBytes.set(new TextEncoder().encode('LCARTV1\0'));
  const value = setup(() => new Response(packageBytes, {
    status: 200,
    headers: {
      'Content-Type': 'application/vnd.leecat.artifact-package.v1',
      'Cache-Control': 'private, no-store',
      Vary: 'Origin, Cookie, Authorization',
      'X-Content-Type-Options': 'nosniff',
    },
  }));
  await value.coordinator.reconcileSessionGeneration();
  const result = await value.api.getArtifactPackage('board_1', artifact);
  assert.equal(result.kind, 'ok');
  if (result.kind === 'ok') assert.equal(result.value.bytes.byteLength, 14);
  assert.equal(value.requests[0]?.url.search, '');
  assert.equal(value.requests[0]?.init?.credentials, 'include');
});

test('network broker selector carries exact CSRF body but grants no direct frame network', async () => {
  const bytes = new Uint8Array(18);
  const value = setup((_url, init) => {
    assert.equal((init?.headers as Headers).get('X-CSRF-Token'), session.csrfToken);
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    assert.match(String(body.requestId), /^req_[A-Za-z0-9_-]{22}$/u);
    assert.deepEqual({ ...body, requestId: '<generated>' }, {
      protocolVersion: 1,
      type: 'artifact.network.fetch.request',
      requestId: '<generated>',
      method: 'HEAD',
      url: 'https://example.dev/data',
    });
    return new Response(bytes, { status: 200, headers: {
      'Content-Type': 'application/vnd.leecat.artifact-network-result.v1',
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    } });
  });
  await value.coordinator.reconcileSessionGeneration();
  const result = await value.api.requestArtifactNetworkFetch({
    boardId: 'board_1', artifact, csrfToken: session.csrfToken, method: 'HEAD', url: 'https://example.dev/data',
  });
  assert.equal(result.kind, 'ok');
  assert.equal(value.requests[0]?.init?.method, 'POST');
});
