import assert from 'node:assert/strict';
import test from 'node:test';

import { BoardEventEnvelopeParserV1 } from '@sceneboard/board-schema';

import { BoardSseService } from '../../src/sse/board-sse.service.js';
import { SseResponseWriter } from '../../src/sse/sse-response-writer.js';
import type { DatabaseOperationOwnershipV1 } from '../../src/database/transaction.js';

test('stream commits exact headers, durable cursor frame, no-ID presence, and exact teardown', async () => {
  const event = BoardEventEnvelopeParserV1.parse({
    protocolVersion: 1,
    type: 'board.event',
    boardId: 'board_1',
    eventId: 'event_1',
    sequence: 1,
    occurredAt: '2026-07-16T00:00:00.000Z',
    revisionId: 'revision_1',
    data: {
      type: 'board.revision.created',
      revision: {
        revisionId: 'revision_1',
        revisionNumber: 1,
        createdAt: '2026-07-16T00:00:00.000Z',
      },
      originType: 'board.create',
      sourceRevisionId: null,
    },
  });
  assert.equal(event.ok, true);
  if (!event.ok) throw new Error('invalid event fixture');
  const catchUpEvent = BoardEventEnvelopeParserV1.parse({
    protocolVersion: 1,
    type: 'board.event',
    boardId: 'board_1',
    eventId: 'event_2',
    sequence: 2,
    occurredAt: '2026-07-16T00:00:01.000Z',
    revisionId: 'revision_2',
    data: {
      type: 'board.revision.created',
      revision: {
        revisionId: 'revision_2',
        revisionNumber: 2,
        createdAt: '2026-07-16T00:00:01.000Z',
      },
      originType: 'scene.replace',
      sourceRevisionId: null,
    },
  });
  assert.equal(catchUpEvent.ok, true);
  if (!catchUpEvent.ok) throw new Error('invalid catch-up event fixture');
  let closeListener: (() => void) | null = null;
  const request = {
    once: (_event: 'close', listener: () => void) => {
      closeListener = listener;
    },
    off: () => undefined,
  };
  const headers = new Map<string, string>();
  const chunks: Buffer[] = [];
  let ended = 0;
  const response = {
    statusCode: 0,
    headersSent: false,
    httpVersionMajor: 1,
    setHeader: (name: string, value: string) => {
      headers.set(name, value);
    },
    removeHeader: (name: string) => {
      headers.delete(name);
    },
    flushHeaders: () => {
      response.headersSent = true;
    },
    write: (chunk: Uint8Array) => {
      chunks.push(Buffer.from(chunk));
      if (chunks.length === 3) (closeListener as unknown as () => void)();
      return true;
    },
    once: () => undefined,
    off: () => undefined,
    end: () => {
      ended += 1;
    },
  };
  let unsubscribed = 0;
  let presenceClosed = 0;
  const service = new BoardSseService(
    {
      prepare: async () => ({
        sequence: 1,
        frames: [
          {
            envelope: event.data.value,
            canonicalBytes: event.data.canonicalBytes,
            cursor: 'cursor_1',
          },
        ],
      }),
      reauthorize: async () => 2,
      rangeAfter: async () => [
        {
          envelope: catchUpEvent.data.value,
          canonicalBytes: catchUpEvent.data.canonicalBytes,
          cursor: 'cursor_2',
        },
      ],
    } as never,
    {
      subscribeBoard: async () => async () => {
        unsubscribed += 1;
      },
    } as never,
    new SseResponseWriter(),
    {
      open: async (input: unknown) => input,
      aggregate: async () => ({ version: 1, presence: [] }),
      touch: async () => true,
      close: async () => {
        presenceClosed += 1;
        return true;
      },
    } as never,
    { generatePublicIdV1: () => 'presence_event_1' } as never,
  );
  await service.stream({
    principal: {
      kind: 'user',
      actor: {
        principalKind: 'user',
        principalId: 'user_1',
        grantId: null,
        scopes: ['board.read'],
      },
      userPk: 1n,
      sessionPk: 1n,
      familyPublicId: 'family_1',
    } as never,
    boardId: 'board_1' as never,
    cursor: null,
    tabId: 'AAAAAAAAAAAAAAAAAAAAAA' as never,
    presenceState: 'online',
    allowedOrigin: 'http://127.0.0.1:3410',
    request,
    response,
  });
  assert.equal(response.statusCode, 200);
  assert.equal(headers.get('Content-Type'), 'text/event-stream; charset=utf-8');
  assert.equal(headers.get('Cache-Control'), 'no-cache, no-store, private');
  assert.equal(headers.get('X-Accel-Buffering'), 'no');
  assert.equal(headers.get('Vary'), 'Origin, Cookie');
  assert.equal(headers.get('Access-Control-Allow-Origin'), 'http://127.0.0.1:3410');
  assert.equal(headers.get('Access-Control-Allow-Credentials'), 'true');
  assert.equal(headers.has('Set-Cookie'), false);
  assert.match(chunks[0]?.toString('utf8') ?? '', /\nid: cursor_1\n/u);
  assert.match(chunks[1]?.toString('utf8') ?? '', /\nid: cursor_2\n/u);
  assert.doesNotMatch(chunks[2]?.toString('utf8') ?? '', /\nid:/u);
  assert.match(chunks[2]?.toString('utf8') ?? '', /"type":"presence.updated"/u);
  assert.equal(unsubscribed, 1);
  assert.equal(presenceClosed, 1);
  assert.equal(ended, 1);
});

test('request close during pending fanout setup cancels ownership as soon as setup resolves', async () => {
  let closeListener: (() => void) | null = null;
  let resolveSubscription: ((unsubscribe: () => Promise<void>) => void) | undefined;
  let setupSignal: AbortSignal | undefined;
  let unsubscribed = 0;
  const service = new BoardSseService(
    {
      prepare: async () => ({ sequence: 0, frames: [] }),
      reauthorize: async () => 0,
    } as never,
    {
      subscribeBoard: async (_boardId: unknown, _wake: unknown, signal: AbortSignal) => {
        setupSignal = signal;
        return new Promise<() => Promise<void>>((resolve) => {
          resolveSubscription = resolve;
        });
      },
    } as never,
    new SseResponseWriter(),
    {} as never,
    {} as never,
  );
  const pending = service.stream({
    principal: {} as never,
    boardId: 'board_1' as never,
    cursor: null,
    tabId: 'AAAAAAAAAAAAAAAAAAAAAA' as never,
    presenceState: 'online',
    allowedOrigin: 'http://127.0.0.1:3410',
    request: {
      once: (_event: 'close', listener: () => void) => {
        closeListener = listener;
      },
      off: () => undefined,
    },
    response: { headersSent: false } as never,
  });
  await Promise.resolve();
  assert.ok(closeListener !== null);
  (closeListener as unknown as () => void)();
  assert.equal(setupSignal?.aborted, true);
  resolveSubscription?.(async () => {
    unsubscribed += 1;
  });
  await pending;
  assert.equal(unsubscribed, 1);
});

test('request close during initial cut aborts database ownership and admits no later resources', async () => {
  let closeListener: (() => void) | null = null;
  let resolvePrepare: ((cut: { sequence: number; frames: [] }) => void) | undefined;
  let ownership: DatabaseOperationOwnershipV1 | undefined;
  const calls = {
    subscribe: 0,
    reauthorize: 0,
    presenceOpen: 0,
    setHeader: 0,
    flushHeaders: 0,
    write: 0,
    end: 0,
  };
  const service = new BoardSseService(
    {
      prepare: async (
        _principal: unknown,
        _boardId: unknown,
        _cursor: unknown,
        _documentSchemaVersion: unknown,
        capturedOwnership: DatabaseOperationOwnershipV1,
      ) => {
        ownership = capturedOwnership;
        return new Promise<{ sequence: number; frames: [] }>((resolve) => {
          resolvePrepare = resolve;
        });
      },
      reauthorize: async () => {
        calls.reauthorize += 1;
        return 0;
      },
    } as never,
    {
      subscribeBoard: async () => {
        calls.subscribe += 1;
        return async () => undefined;
      },
    } as never,
    {
      write: async () => {
        calls.write += 1;
      },
    } as never,
    {
      open: async () => {
        calls.presenceOpen += 1;
        return {};
      },
    } as never,
    {} as never,
  );
  const response = {
    headersSent: false,
    setHeader: () => {
      calls.setHeader += 1;
    },
    flushHeaders: () => {
      calls.flushHeaders += 1;
    },
    write: () => {
      calls.write += 1;
      return true;
    },
    end: () => {
      calls.end += 1;
    },
  } as never;
  const pending = service.stream({
    principal: { kind: 'user', userPk: 1n } as never,
    boardId: 'board_1' as never,
    cursor: null,
    tabId: 'AAAAAAAAAAAAAAAAAAAAAA' as never,
    presenceState: 'online',
    allowedOrigin: 'http://127.0.0.1:3410',
    request: {
      once: (_event: 'close', listener: () => void) => {
        closeListener = listener;
      },
      off: () => undefined,
    },
    response,
  });
  await Promise.resolve();
  assert.ok(closeListener !== null);
  assert.ok(ownership !== undefined);
  (closeListener as unknown as () => void)();
  assert.equal(ownership?.signal.aborted, true);
  resolvePrepare?.({ sequence: 0, frames: [] });
  await pending;
  assert.deepEqual(calls, {
    subscribe: 0,
    reauthorize: 0,
    presenceOpen: 0,
    setHeader: 0,
    flushHeaders: 0,
    write: 0,
    end: 0,
  });
});

test('SSE cleanup closes presence and response even when fanout teardown rejects', async () => {
  let closeListener: (() => void) | null = null;
  let presenceClosed = 0;
  let ended = 0;
  const teardownFailure = new Error('fixture fanout teardown failure');
  const service = new BoardSseService(
    {
      prepare: async () => ({ sequence: 0, frames: [] }),
      reauthorize: async () => 0,
    } as never,
    {
      subscribeBoard: async () => async () => {
        throw teardownFailure;
      },
    } as never,
    new SseResponseWriter(),
    {
      async open() {
        (closeListener as unknown as () => void)();
        return { lease: 'presence' };
      },
      async close() {
        presenceClosed += 1;
        return true;
      },
    } as never,
    {} as never,
  );
  await assert.rejects(
    service.stream({
      principal: { kind: 'user', userPk: 1n } as never,
      boardId: 'board_1' as never,
      cursor: null,
      tabId: 'AAAAAAAAAAAAAAAAAAAAAA' as never,
      presenceState: 'online',
      allowedOrigin: 'http://127.0.0.1:3410',
      request: {
        once: (_event: 'close', listener: () => void) => {
          closeListener = listener;
        },
        off: () => undefined,
      },
      response: {
        headersSent: true,
        end() {
          ended += 1;
        },
      } as never,
    }),
    teardownFailure,
  );
  assert.equal(presenceClosed, 1);
  assert.equal(ended, 1);
});
