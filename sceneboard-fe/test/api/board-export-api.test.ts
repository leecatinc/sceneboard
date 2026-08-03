import assert from 'node:assert/strict';
import test from 'node:test';

import type { SessionRequestCoordinator } from '../../lib/auth/renewal-singleflight';
import {
  BOARD_EXPORT_FAILURES_V1,
  BoardExportApi,
  publishBoardExportDownloadV1,
  type BoardExportFormatV1,
} from '../../lib/api/board-export-api';

const successBytes = (format: BoardExportFormatV1): Uint8Array =>
  format === 'pdf'
    ? Uint8Array.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31])
    : Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0]);

const successContentType = (format: BoardExportFormatV1): string =>
  format === 'pdf'
    ? 'application/pdf'
    : 'application/vnd.openxmlformats-officedocument.presentationml.presentation';

const apiWith = (
  response: Response,
  bytes: Uint8Array,
  body: unknown,
  requests: unknown[],
): BoardExportApi =>
  new BoardExportApi({
    currentSnapshot: () => ({ csrfToken: 'synthetic-csrf' }),
    dispatchShared: async (request: unknown) => {
      requests.push(request);
      return { kind: 'ok', value: { response, bytes, body } };
    },
  } as unknown as SessionRequestCoordinator);

const apiWithDispatch = (
  dispatchShared: SessionRequestCoordinator['dispatchShared'],
): BoardExportApi =>
  new BoardExportApi({
    currentSnapshot: () => ({ csrfToken: 'synthetic-csrf' }),
    dispatchShared,
  } as unknown as SessionRequestCoordinator);

const run = async (
  api: BoardExportApi,
  format: BoardExportFormatV1 = 'pdf',
  signal: AbortSignal = new AbortController().signal,
) =>
  await api.export({
    boardId: 'board_fixture_01',
    revisionId: 'revision_fixture_01',
    format,
    signal,
  });

const flushMicrotasks = async (): Promise<void> => {
  for (let index = 0; index < 6; index += 1) await Promise.resolve();
};

test('owner export sends one exact revision-pinned request and admits complete PDF/PPTX bytes', async () => {
  for (const format of ['pdf', 'pptx'] as const) {
    const requests: unknown[] = [];
    const bytes = successBytes(format);
    const response = new Response(null, {
      status: 200,
      headers: {
        'Content-Type': successContentType(format),
        'Content-Disposition': `attachment; filename="Roadmap.Draft-r7.${format}"`,
        'Content-Length': String(bytes.byteLength),
        'Cache-Control': 'no-store, private',
        Pragma: 'no-cache',
        'X-Content-Type-Options': 'nosniff',
      },
    });
    const result = await run(apiWith(response, bytes, null, requests), format);
    assert.equal(result.kind, 'ok');
    assert.deepEqual(requests, [
      {
        path: '/api/v1/boards/board_fixture_01/exports',
        method: 'POST',
        body: { format, revisionId: 'revision_fixture_01' },
        csrfToken: 'synthetic-csrf',
        responseKind: 'export',
        signal: requests.length === 1 ? (requests[0] as { signal: AbortSignal }).signal : undefined,
      },
    ]);
  }
});

test('the exact 120-second deadline settles non-cooperative dispatch and observes a late rejection', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  let dispatchedSignal: AbortSignal | undefined;
  let rejectDispatch: ((reason: Error) => void) | undefined;
  const dispatch = new Promise<never>((_resolve, reject) => {
    rejectDispatch = reject;
  });
  const pending = run(
    apiWithDispatch((request) => {
      dispatchedSignal = request.signal;
      return dispatch;
    }),
  );
  let settled = false;
  void pending.then(() => {
    settled = true;
  });

  context.mock.timers.tick(119_999);
  await flushMicrotasks();
  assert.equal(settled, false);
  assert.equal(dispatchedSignal?.aborted, false);

  context.mock.timers.tick(1);
  await flushMicrotasks();
  assert.equal(settled, true);
  assert.equal(dispatchedSignal?.aborted, true);
  assert.deepEqual(await pending, {
    kind: 'error',
    error: { code: 'EXPORT_RENDER_TIMEOUT', retryable: true },
  });

  rejectDispatch?.(new Error('late synthetic dispatch rejection'));
  await flushMicrotasks();
});

test('caller cancellation settles an abort-ignoring dispatch before the export deadline', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const caller = new AbortController();
  let dispatchedSignal: AbortSignal | undefined;
  const pending = run(
    apiWithDispatch((request) => {
      dispatchedSignal = request.signal;
      return new Promise<never>(() => undefined);
    }),
    'pdf',
    caller.signal,
  );
  caller.abort(new DOMException('synthetic caller cancellation', 'AbortError'));
  await flushMicrotasks();

  assert.equal(dispatchedSignal?.aborted, true);
  assert.deepEqual(await pending, {
    kind: 'error',
    error: { code: 'EXPORT_BROWSER_UNAVAILABLE', retryable: false },
  });
});

test('success clears the deadline and removes the caller cancellation listener', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const caller = new AbortController();
  const addListener = context.mock.method(caller.signal, 'addEventListener');
  const removeListener = context.mock.method(caller.signal, 'removeEventListener');
  let dispatchedSignal: AbortSignal | undefined;
  const bytes = successBytes('pdf');
  const response = new Response(null, {
    status: 200,
    headers: {
      'Content-Type': successContentType('pdf'),
      'Content-Disposition': 'attachment; filename="Roadmap.Draft-r7.pdf"',
      'Content-Length': String(bytes.byteLength),
      'Cache-Control': 'no-store, private',
      Pragma: 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    },
  });
  const result = await run(
    apiWithDispatch(async (request) => {
      dispatchedSignal = request.signal;
      return { kind: 'ok', value: { response, bytes, body: null } };
    }),
    'pdf',
    caller.signal,
  );

  assert.equal(result.kind, 'ok');
  assert.equal(addListener.mock.callCount(), 1);
  assert.equal(removeListener.mock.callCount(), 1);
  context.mock.timers.tick(120_000);
  assert.equal(dispatchedSignal?.aborted, false);
});

test('redirected, 3xx, and opaque manual redirect responses are cancelled and rejected closed', async (context) => {
  const bytes = successBytes('pdf');
  const headers = {
    'Content-Type': successContentType('pdf'),
    'Content-Disposition': 'attachment; filename="Roadmap.Draft-r7.pdf"',
    'Content-Length': String(bytes.byteLength),
    'Cache-Control': 'no-store, private',
    Pragma: 'no-cache',
    'X-Content-Type-Options': 'nosniff',
  };
  const followed = new Response('followed bytes', { status: 200, headers });
  Object.defineProperty(followed, 'redirected', { configurable: true, value: true });
  const sameOrigin = new Response('redirect body', {
    status: 302,
    headers: { Location: '/api/v1/boards/board_fixture_01/exports' },
  });
  const opaque = new Response('opaque redirect body', { status: 200 });
  Object.defineProperty(opaque, 'type', { configurable: true, value: 'opaqueredirect' });

  for (const response of [followed, sameOrigin, opaque]) {
    const cancel = context.mock.method(response.body!, 'cancel');
    assert.deepEqual(await run(apiWith(response, bytes, null, [])), {
      kind: 'error',
      error: { code: 'EXPORT_RESPONSE_INVALID', retryable: false },
    });
    assert.equal(cancel.mock.callCount(), 1);
  }
});

test('all eleven server failures preserve the exact retryable decision', async () => {
  for (const [code, definition] of Object.entries(BOARD_EXPORT_FAILURES_V1)) {
    const body = {
      ok: false,
      error: { code, message: definition.message, retryable: definition.retryable },
    };
    const response = new Response(JSON.stringify(body), {
      status: definition.status,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    });
    assert.deepEqual(await run(apiWith(response, new TextEncoder().encode('{}'), body, [])), {
      kind: 'error',
      error: { code, retryable: definition.retryable },
    });
  }
});

test('partial, malformed and contradictory success or failure responses never become downloads', async () => {
  const bytes = successBytes('pdf');
  const baseHeaders = {
    'Content-Type': 'application/pdf',
    'Content-Disposition': 'attachment; filename="fixture-r7.pdf"',
    'Content-Length': String(bytes.byteLength),
    'Cache-Control': 'no-store, private',
    Pragma: 'no-cache',
    'X-Content-Type-Options': 'nosniff',
  };
  const invalidResponses = [
    [
      new Response(null, { status: 200, headers: { ...baseHeaders, 'Content-Length': '99' } }),
      bytes,
    ],
    [
      new Response(null, { status: 200, headers: baseHeaders }),
      Uint8Array.from([1, 2, 3, 4, 5, 6]),
    ],
    [
      new Response(null, {
        status: 200,
        headers: { ...baseHeaders, 'Content-Disposition': 'attachment; filename="../bad.pdf"' },
      }),
      bytes,
    ],
  ] as const;
  for (const [response, candidate] of invalidResponses)
    assert.deepEqual(await run(apiWith(response, candidate, null, [])), {
      kind: 'error',
      error: { code: 'EXPORT_RESPONSE_INVALID', retryable: false },
    });

  const definition = BOARD_EXPORT_FAILURES_V1.EXPORT_RATE_LIMITED;
  const contradictory = {
    ok: false,
    error: { code: 'EXPORT_RATE_LIMITED', message: definition.message, retryable: false },
  };
  assert.deepEqual(
    await run(
      apiWith(
        new Response(JSON.stringify(contradictory), { status: definition.status }),
        new TextEncoder().encode('{}'),
        contradictory,
        [],
      ),
    ),
    {
      kind: 'error',
      error: { code: 'EXPORT_RESPONSE_INVALID', retryable: false },
    },
  );
});

test('download publication uses only an admitted complete result and always revokes the URL', () => {
  const events: string[] = [];
  publishBoardExportDownloadV1(
    {
      format: 'pdf',
      bytes: successBytes('pdf'),
      fileName: 'fixture-r7.pdf',
      contentType: 'application/pdf',
    },
    {
      createObjectUrl: (blob) => {
        events.push(`create:${blob.type}:${blob.size}`);
        return 'blob:synthetic';
      },
      clickDownload: ({ url, fileName }) => events.push(`click:${url}:${fileName}`),
      revokeObjectUrl: (url) => events.push(`revoke:${url}`),
    },
  );
  assert.deepEqual(events, [
    'create:application/pdf:6',
    'click:blob:synthetic:fixture-r7.pdf',
    'revoke:blob:synthetic',
  ]);
});
