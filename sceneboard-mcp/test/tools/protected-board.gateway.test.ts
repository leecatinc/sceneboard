import assert from 'node:assert/strict';
import test from 'node:test';

import type { TokenProviderV1 } from '../../src/credentials/token-provider.js';
import { ProtectedBoardGatewayV1 } from '../../src/tools/protected-board.gateway.js';

const pairingToken = `lcbg_v1.${'a'.repeat(22)}.${'b'.repeat(43)}`;
const apiKey = `sbk_v1.${'A'.repeat(22)}.${'B'.repeat(43)}`;

const deferred = <Value>() => {
  let resolve!: (value: Value) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

const resultCode = (result: unknown): string | undefined =>
  (result as { value?: { error?: { code?: string } } }).value?.error?.code;

const gateway = (input: {
  timeoutMs?: number;
  exportTimeoutMs?: number;
  credentialMode?: 'pairing' | 'api_key';
  tokens: TokenProviderV1;
  fetch?: typeof fetch;
}): ProtectedBoardGatewayV1 =>
  new ProtectedBoardGatewayV1({
    baseUrl: 'https://sceneboard.dev',
    timeoutMs: input.timeoutMs ?? 25,
    ...(input.exportTimeoutMs === undefined ? {} : { exportTimeoutMs: input.exportTimeoutMs }),
    credentialMode: input.credentialMode ?? 'pairing',
    tokens: input.tokens,
    fetch:
      input.fetch ??
      (async () => {
        throw new Error('unexpected fetch');
      }),
    logger: { log() {} },
  });

const snapshot = (accessToken = pairingToken) => ({
  version: 1 as const,
  generation: 'environment_v1_token',
  accessToken,
});

test('pairing calls classify pre-abort and mid-snapshot abort without downstream dispatch', async () => {
  for (const phase of ['pre', 'mid'] as const) {
    const pending = deferred<ReturnType<typeof snapshot> | null>();
    const controller = new AbortController();
    let fetchCalls = 0;
    let operationCalls = 0;
    let snapshotSignal: AbortSignal | undefined;
    const client = gateway({
      tokens: {
        snapshot: async (signal) => {
          snapshotSignal = signal;
          return pending.promise;
        },
        invalidate: async () => undefined,
      },
      fetch: async () => {
        fetchCalls += 1;
        throw new Error('must not dispatch');
      },
    });
    if (phase === 'pre') controller.abort();
    const call = client.call(
      async () => {
        operationCalls += 1;
        return { ok: true as const };
      },
      { signal: controller.signal },
    );
    if (phase === 'mid') controller.abort();
    const result = await call;
    assert.equal(result.connected, true);
    assert.equal(resultCode(result), 'CANCELLED');
    if (phase === 'pre') assert.equal(snapshotSignal, undefined);
    else assert.equal(snapshotSignal?.aborted, true);
    assert.equal(fetchCalls, 0);
    assert.equal(operationCalls, 0);
    pending.resolve(snapshot());
    await new Promise((resolve) => setImmediate(resolve));
    pending.reject(new Error('ignored late rejection'));
  }
});

test('pairing snapshot and operation timeouts suppress late settlement and never dispatch late work', async () => {
  const snapshotPending = deferred<ReturnType<typeof snapshot> | null>();
  let operationCalls = 0;
  const snapshotClient = gateway({
    timeoutMs: 10,
    tokens: {
      snapshot: async () => snapshotPending.promise,
      invalidate: async () => undefined,
    },
  });
  const snapshotResult = await snapshotClient.call(async () => {
    operationCalls += 1;
    return { ok: true as const };
  });
  assert.equal(resultCode(snapshotResult), 'TIMEOUT');
  assert.equal(operationCalls, 0);
  snapshotPending.resolve(snapshot());

  const operationPending = deferred<{ ok: true }>();
  const operationClient = gateway({
    timeoutMs: 10,
    tokens: {
      snapshot: async () => snapshot(),
      invalidate: async () => undefined,
    },
  });
  const operationResult = await operationClient.call(async (_client, _snapshot, signal) => {
    assert.equal(signal.aborted, false);
    return operationPending.promise;
  });
  assert.equal(resultCode(operationResult), 'TIMEOUT');
  operationPending.reject(new Error('ignored late rejection'));
  await new Promise((resolve) => setImmediate(resolve));
});

test('API-key preflight and invalidation share the original deadline and block tool dispatch', async () => {
  const preflightPending = deferred<Response>();
  let operationCalls = 0;
  const preflightClient = gateway({
    timeoutMs: 10,
    credentialMode: 'api_key',
    tokens: {
      snapshot: async () => snapshot(apiKey),
      invalidate: async () => undefined,
    },
    fetch: async () => preflightPending.promise,
  });
  const preflightResult = await preflightClient.call(
    'board_get',
    'board.get',
    {
      signal: undefined,
      authorization: { boardId: 'board_1', operation: 'board.get' },
    },
    async () => {
      operationCalls += 1;
      return { ok: true as const };
    },
  );
  assert.equal(resultCode(preflightResult), 'TIMEOUT');
  assert.equal(operationCalls, 0);
  preflightPending.resolve(new Response());

  const invalidationPending = deferred<void>();
  let invalidationSignal: AbortSignal | undefined;
  const invalidationClient = gateway({
    timeoutMs: 10,
    credentialMode: 'api_key',
    tokens: {
      snapshot: async () => snapshot(apiKey),
      invalidate: async (_snapshot, signal) => {
        invalidationSignal = signal;
        return invalidationPending.promise;
      },
    },
    fetch: async (request) => {
      const url = new URL(request instanceof Request ? request.url : request);
      const requestId = url.searchParams.get('requestId') ?? '';
      return new Response(
        JSON.stringify({
          error: {
            protocolVersion: 1,
            type: 'board.error',
            code: 'UNAUTHENTICATED',
            message: 'Authentication is required',
            category: 'auth',
            retryable: false,
            httpStatusHint: 401,
            details: null,
          },
        }),
        {
          status: 401,
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store, private',
            Pragma: 'no-cache',
            Vary: 'Origin, Cookie, Authorization',
            'X-Request-Id': requestId,
          },
        },
      );
    },
  });
  const invalidationResult = await invalidationClient.call(
    'board_get',
    'board.get',
    {
      signal: undefined,
      authorization: { boardId: 'board_1', operation: 'board.get' },
    },
    async () => {
      operationCalls += 1;
      return { ok: true as const };
    },
  );
  assert.equal(resultCode(invalidationResult), 'TIMEOUT');
  assert.equal(invalidationSignal?.aborted, true);
  assert.equal(operationCalls, 0);
  invalidationPending.resolve();
});

test('media authorization, rename, and export reject pre-aborted work before network dispatch', async () => {
  const controller = new AbortController();
  controller.abort();
  let fetchCalls = 0;
  let operationCalls = 0;
  const client = gateway({
    tokens: {
      snapshot: async () => snapshot(),
      invalidate: async () => undefined,
    },
    fetch: async () => {
      fetchCalls += 1;
      throw new Error('must not dispatch');
    },
  });
  const authorized = await client.withAuthorizedBoardOperation(
    {
      boardId: 'board_1',
      requestId: 'request_1',
      requiredCapabilities: ['board.media.write'],
      signal: controller.signal,
    },
    async () => {
      operationCalls += 1;
      return null;
    },
  );
  assert.equal(authorized.authorized, false);
  if (!authorized.authorized && authorized.reason === 'local')
    assert.equal(authorized.error.code, 'CANCELLED');

  const renamed = await client.renameBoard({
    boardId: 'board_1',
    title: 'Renamed',
    signal: controller.signal,
  });
  assert.equal(renamed.connected, true);
  if (renamed.connected && !renamed.value.ok) assert.equal(renamed.value.error.code, 'CANCELLED');

  const exported = await client.exportBoard({
    boardId: 'board_1',
    revisionId: null,
    format: 'pdf',
    signal: controller.signal,
    publish: async () => {
      operationCalls += 1;
      throw new Error('must not publish');
    },
  });
  assert.equal(exported.connected, true);
  if (exported.connected && !exported.value.ok)
    assert.equal(exported.value.error.code, 'CANCELLED');
  assert.equal(fetchCalls, 0);
  assert.equal(operationCalls, 0);
});

test('API-key board probes carry exact ownership context and reject before operation or export publication', async () => {
  const probes: Array<{ boardId: string | null; operation: string | null }> = [];
  let operationCalls = 0;
  let publications = 0;
  const client = gateway({
    credentialMode: 'api_key',
    tokens: {
      snapshot: async () => snapshot(apiKey),
      invalidate: async () => undefined,
    },
    fetch: async (request) => {
      const url = new URL(request instanceof Request ? request.url : request);
      const requestId = url.searchParams.get('requestId') ?? '';
      probes.push({
        boardId: url.searchParams.get('boardId'),
        operation: url.searchParams.get('authorizationOperation'),
      });
      return new Response(
        JSON.stringify({
          error: {
            protocolVersion: 1,
            type: 'board.error',
            code: 'BOARD_NOT_FOUND',
            message: 'Board not found',
            category: 'not_found',
            retryable: false,
            httpStatusHint: 404,
            details: null,
          },
        }),
        {
          status: 404,
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store, private',
            Pragma: 'no-cache',
            Vary: 'Origin, Cookie, Authorization',
            'X-Request-Id': requestId,
          },
        },
      );
    },
  });
  const history = await client.call(
    'board_history_get',
    'history.get',
    {
      signal: undefined,
      authorization: { boardId: 'board_1', operation: 'history.get' },
    },
    async () => {
      operationCalls += 1;
      return { ok: true as const };
    },
  );
  assert.equal(resultCode(history), 'BOARD_NOT_FOUND');
  const renamed = await client.renameBoard({ boardId: 'board_3', title: 'Never' });
  assert.equal(resultCode(renamed), 'BOARD_NOT_FOUND');
  const exported = await client.exportBoard({
    boardId: 'board_2',
    revisionId: null,
    format: 'pdf',
    publish: async () => {
      publications += 1;
      return {
        ok: true,
        value: { format: 'pdf', bytes: 5, fileName: 'never.pdf' },
      };
    },
  });
  assert.equal(exported.connected, true);
  if (exported.connected && !exported.value.ok)
    assert.equal(exported.value.error.code, 'EXPORT_NOT_FOUND');
  assert.deepEqual(probes, [
    { boardId: 'board_1', operation: 'history.get' },
    { boardId: 'board_3', operation: 'board.rename' },
    { boardId: 'board_2', operation: 'export.render' },
  ]);
  assert.equal(operationCalls, 0);
  assert.equal(publications, 0);
});

test('API-key authorized operations reject an authorization operation outside the selected plan', async () => {
  let fetchCalls = 0;
  let operationCalls = 0;
  const client = gateway({
    credentialMode: 'api_key',
    tokens: {
      snapshot: async () => snapshot(apiKey),
      invalidate: async () => undefined,
    },
    fetch: async () => {
      fetchCalls += 1;
      throw new Error('must not dispatch');
    },
  });
  const result = await client.withAuthorizedBoardOperation(
    {
      boardId: 'board_1',
      requestId: 'request_1',
      requiredCapabilities: ['board.write'],
      apiKeyToolName: 'sceneboard_media_place',
      apiKeyOperationPlan: ['history.get', 'document.replace'],
      apiKeyAuthorizationOperation: 'artifact.publish',
    },
    async () => {
      operationCalls += 1;
      return null;
    },
  );
  assert.deepEqual(result, { authorized: false, reason: 'credential_unavailable' });
  assert.equal(fetchCalls, 0);
  assert.equal(operationCalls, 0);
});

test('export bounds terminal settlement after the owned publication deadline', async () => {
  let snapshots = 0;
  let publications = 0;
  let publicationSignal: AbortSignal | undefined;
  const client = new ProtectedBoardGatewayV1({
    baseUrl: 'https://sceneboard.dev',
    timeoutMs: 30_000,
    exportTimeoutMs: 10,
    credentialMode: 'pairing',
    tokens: {
      snapshot: async () => {
        snapshots += 1;
        return snapshot();
      },
      invalidate: async () => undefined,
    },
    fetch: async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(Buffer.from('%PDF-', 'ascii'));
          },
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/pdf', 'Content-Length': '10' },
        },
      ),
    logger: { log() {} },
  });
  const startedAt = Date.now();
  const result = await client.exportBoard({
    boardId: 'board_1',
    revisionId: null,
    format: 'pdf',
    publish: async (_artifact, signal) => {
      publications += 1;
      publicationSignal = signal;
      return new Promise(() => undefined);
    },
  });
  assert.equal(resultCode(result), 'TIMEOUT');
  assert.equal(snapshots, 1);
  assert.equal(publications, 1);
  assert.equal(publicationSignal?.aborted, true);
  assert.equal(Date.now() - startedAt < 2_000, true);
});

test('export accepts acknowledged success after caller cancellation once publication starts', async () => {
  const controller = new AbortController();
  const publicationStarted = deferred<void>();
  const finalPaths = new Set<string>();
  const reserveTarget = (path: string): boolean => {
    if (finalPaths.has(path)) return false;
    finalPaths.add(path);
    return true;
  };
  const client = gateway({
    timeoutMs: 30_000,
    exportTimeoutMs: 30_000,
    tokens: { snapshot: async () => snapshot(), invalidate: async () => undefined },
    fetch: async () =>
      new Response(Buffer.from('%PDF-', 'ascii'), {
        status: 200,
        headers: { 'Content-Type': 'application/pdf', 'Content-Length': '5' },
      }),
  });
  const exported = client.exportBoard({
    boardId: 'board_1',
    revisionId: 'revision_1',
    format: 'pdf',
    signal: controller.signal,
    publish: async (_artifact, signal) => {
      assert.equal(reserveTarget('acknowledged.pdf'), true);
      publicationStarted.resolve();
      await new Promise<void>((resolve) =>
        signal.addEventListener('abort', () => resolve(), { once: true }),
      );
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 350));
      return { ok: true, value: { format: 'pdf', bytes: 5, fileName: 'acknowledged.pdf' } };
    },
  });
  await publicationStarted.promise;
  controller.abort();
  const result = await exported;
  assert.equal(result.connected, true);
  if (result.connected) assert.equal(result.value.ok, true);
  assert.equal(finalPaths.has('acknowledged.pdf'), true);
  assert.equal(reserveTarget('acknowledged.pdf'), false);
});

test('export deadline preserves rollback failure and leaves the target retryable', async () => {
  const finalPaths = new Set<string>();
  const reserveTarget = (path: string): boolean => {
    if (finalPaths.has(path)) return false;
    finalPaths.add(path);
    return true;
  };
  const client = gateway({
    timeoutMs: 30_000,
    exportTimeoutMs: 10,
    tokens: { snapshot: async () => snapshot(), invalidate: async () => undefined },
    fetch: async () =>
      new Response(Buffer.from('%PDF-', 'ascii'), {
        status: 200,
        headers: { 'Content-Type': 'application/pdf', 'Content-Length': '5' },
      }),
  });
  const result = await client.exportBoard({
    boardId: 'board_1',
    revisionId: 'revision_1',
    format: 'pdf',
    publish: async (_artifact, signal) => {
      assert.equal(reserveTarget('rolled-back.pdf'), true);
      await new Promise<void>((resolve) =>
        signal.addEventListener('abort', () => resolve(), { once: true }),
      );
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 350));
      finalPaths.delete('rolled-back.pdf');
      return {
        ok: false,
        error: {
          code: 'LOCAL_EXPORT_CANCELLED',
          message: 'Local export was cancelled',
          retryable: false,
          details: null,
        },
      };
    },
  });
  assert.equal(resultCode(result), 'TIMEOUT');
  assert.equal(finalPaths.has('rolled-back.pdf'), false);
  assert.equal(reserveTarget('rolled-back.pdf'), true);
});
