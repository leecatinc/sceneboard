import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  BoardEventEnvelopeParserV1,
  canonicalizeJsonV1,
  type BoardErrorV1,
  type BoardError,
  type BoardEventEnvelopeV1,
  type BoardId,
} from '@sceneboard/board-schema';

import {
  createBoardStreamClientV1,
  createBoardStreamClientV2,
  createBoardStreamClientV3,
  createBoardStreamTabIdV1,
  type BoardStreamDispatchPortV1,
  type BoardStreamStateV1,
} from '../../src/sse/index.js';

const BOARD_ID = 'board_1' as BoardId;
const TAB_ID = 'abcdefghijklmnopqrstuv';
const fixtureRoot = new URL('../../../board-schema/test/fixtures/valid/', import.meta.url);
const encoder = new TextEncoder();

const forbiddenError: BoardErrorV1 = {
  protocolVersion: 1,
  type: 'board.error',
  code: 'FORBIDDEN',
  message: 'Forbidden',
  category: 'auth',
  retryable: false,
  httpStatusHint: 403,
  details: null,
};

const documentMismatchError: BoardError = {
  protocolVersion: 1,
  type: 'board.error',
  code: 'DOCUMENT_VERSION_MISMATCH',
  message: 'Document version mismatch',
  category: 'conflict',
  retryable: false,
  httpStatusHint: 409,
  details: {
    headSchemaVersion: 2,
    commandSchemaVersion: 1,
    commandType: 'scene.replace',
  },
};

const snapshotEvent = (): BoardEventEnvelopeV1 => {
  const parsed = BoardEventEnvelopeParserV1.parse(
    JSON.parse(readFileSync(new URL('event-board-snapshot.v1.json', fixtureRoot), 'utf8')),
  );
  assert.equal(parsed.ok, true);
  if (!parsed.ok) throw new Error('invalid snapshot fixture');
  return parsed.data.value;
};

const snapshotFrame = (): Uint8Array => {
  const canonical = canonicalizeJsonV1(snapshotEvent());
  assert.equal(canonical.ok, true);
  if (!canonical.ok) throw new Error('snapshot fixture canonicalization failed');
  const prefix = encoder.encode('event: board.event.v1\nid: cursor_1\ndata: ');
  const suffix = encoder.encode('\n\n');
  const output = new Uint8Array(
    prefix.byteLength + canonical.data.canonicalBytes.byteLength + suffix.byteLength,
  );
  output.set(prefix);
  output.set(canonical.data.canonicalBytes, prefix.byteLength);
  output.set(suffix, prefix.byteLength + canonical.data.canonicalBytes.byteLength);
  return output;
};

const callbacks = (states: BoardStreamStateV1[]) => ({
  replaceSnapshot: async () => undefined,
  refreshRevisionSnapshot: async () => ({
    kind: 'authoritative_revision_snapshot' as const,
    lastEventSequence: 1,
  }),
  applyDurableEvent: async () => undefined,
  replacePresence: async () => undefined,
  onState: async (state: BoardStreamStateV1) => {
    states.push(state);
  },
});

test('classifies a closed 403 dispatch outcome without collapsing it into logout', async () => {
  const states: BoardStreamStateV1[] = [];
  const dispatch: BoardStreamDispatchPortV1 = {
    open: async () => ({
      kind: 'http_error',
      sourceStatus: 403,
      error: forbiddenError,
      retryAfterMs: null,
    }),
  };
  const client = createBoardStreamClientV1({
    apiOrigin: 'https://sceneboard.dev',
    boardId: BOARD_ID,
    tabId: TAB_ID,
    initialPresenceState: 'online',
    minimumSnapshotSequence: 1,
    dispatch,
    callbacks: callbacks(states),
    routeSignal: new AbortController().signal,
  });

  const result = await client.start();
  assert.deepEqual(result, {
    kind: 'terminal',
    failure: { kind: 'forbidden', sourceStatus: 403, error: forbiddenError },
  });
  assert.deepEqual(
    states.map((state) => state.state),
    ['connecting', 'terminal'],
  );
  assert.equal(await client.stop(), result);
});

test('passes the negotiated document parser discriminator to every stream dispatch', async () => {
  const states: BoardStreamStateV1[] = [];
  let negotiated: number | null = null;
  const dispatch: BoardStreamDispatchPortV1 = {
    open: async (input) => {
      negotiated = input.documentSchemaVersion ?? 1;
      return {
        kind: 'http_error',
        sourceStatus: 403,
        error: forbiddenError,
        retryAfterMs: null,
      };
    },
  };
  const client = createBoardStreamClientV2({
    apiOrigin: 'https://sceneboard.dev',
    boardId: BOARD_ID,
    tabId: TAB_ID,
    initialPresenceState: 'online',
    documentSchemaVersion: 2,
    minimumSnapshotSequence: 1,
    dispatch,
    callbacks: callbacks(states),
    routeSignal: new AbortController().signal,
  });
  await client.start();
  assert.equal(negotiated, 2);

  const v3 = createBoardStreamClientV3({
    apiOrigin: 'https://sceneboard.dev',
    boardId: BOARD_ID,
    tabId: TAB_ID,
    initialPresenceState: 'online',
    documentSchemaVersion: 3,
    minimumSnapshotSequence: 1,
    dispatch,
    callbacks: callbacks(states),
    routeSignal: new AbortController().signal,
  });
  await v3.start();
  assert.equal(negotiated, 3);
});

test('preserves a pre-header V1-to-V2 stream mismatch as a terminal error', async () => {
  const states: BoardStreamStateV1[] = [];
  const dispatch: BoardStreamDispatchPortV1 = {
    open: async () => ({
      kind: 'http_error',
      sourceStatus: 409,
      error: documentMismatchError,
      retryAfterMs: null,
    }),
  };
  const client = createBoardStreamClientV1({
    apiOrigin: 'https://sceneboard.dev',
    boardId: BOARD_ID,
    tabId: TAB_ID,
    initialPresenceState: 'online',
    minimumSnapshotSequence: 1,
    dispatch,
    callbacks: callbacks(states),
    routeSignal: new AbortController().signal,
  });
  assert.deepEqual(await client.start(), {
    kind: 'terminal',
    failure: {
      kind: 'document_version_mismatch',
      sourceStatus: 409,
      error: documentMismatchError,
    },
  });
});

test('terminates on a snapshot callback rejection before committing its cursor', async () => {
  const states: BoardStreamStateV1[] = [];
  const dispatch: BoardStreamDispatchPortV1 = {
    open: async (input, consume) =>
      consume(
        new Response(snapshotFrame().slice().buffer as ArrayBuffer, {
          headers: { 'Content-Type': 'text/event-stream; charset=utf-8' },
        }),
        input.signal,
      ).then((value) => ({ kind: 'consumed', value })),
  };
  const client = createBoardStreamClientV1({
    apiOrigin: 'https://sceneboard.dev',
    boardId: BOARD_ID,
    tabId: TAB_ID,
    initialPresenceState: 'online',
    minimumSnapshotSequence: 1,
    dispatch,
    callbacks: {
      ...callbacks(states),
      replaceSnapshot: async () => {
        throw new Error('consumer failed');
      },
    },
    routeSignal: new AbortController().signal,
  });

  assert.deepEqual(await client.start(), {
    kind: 'terminal',
    failure: { kind: 'consumer_callback', callback: 'snapshot' },
  });
  assert.deepEqual(
    states.map((state) => state.state),
    ['connecting', 'terminal'],
  );
});

test('awaits snapshot commit, reports live, then stops and releases the active reader', async () => {
  const states: BoardStreamStateV1[] = [];
  const dispatch: BoardStreamDispatchPortV1 = {
    open: async (input, consume) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(snapshotFrame());
          input.signal.addEventListener(
            'abort',
            () => controller.error(new DOMException('Aborted', 'AbortError')),
            {
              once: true,
            },
          );
        },
      });
      const value = await consume(
        new Response(body, {
          headers: { 'Content-Type': 'text/event-stream; charset=utf-8' },
        }),
        input.signal,
      );
      return { kind: 'consumed', value };
    },
  };
  const client = createBoardStreamClientV1({
    apiOrigin: 'https://sceneboard.dev',
    boardId: BOARD_ID,
    tabId: TAB_ID,
    initialPresenceState: 'online',
    minimumSnapshotSequence: 1,
    dispatch,
    callbacks: {
      ...callbacks(states),
      onState: async (state) => {
        states.push(state);
        if (state.state === 'live') void client.stop('context_loss');
      },
    },
    routeSignal: new AbortController().signal,
  });

  assert.deepEqual(await client.start(), { kind: 'stopped', reason: 'context_loss' });
  assert.deepEqual(
    states.map((state) => state.state),
    ['connecting', 'live'],
  );
});

test('creates memory-only tab IDs with the exact public grammar', () => {
  const first = createBoardStreamTabIdV1();
  const second = createBoardStreamTabIdV1();
  assert.match(first, /^[A-Za-z0-9_-]{22}$/);
  assert.match(second, /^[A-Za-z0-9_-]{22}$/);
  assert.notEqual(first, second);
});

test('validates every closed client option before dispatch', () => {
  const states: BoardStreamStateV1[] = [];
  const dispatch: BoardStreamDispatchPortV1 = {
    open: async () => {
      throw new Error('must not be called');
    },
  };
  assert.throws(
    () =>
      createBoardStreamClientV1({
        apiOrigin: 'https://sceneboard.dev/path',
        boardId: BOARD_ID,
        tabId: 'short',
        initialPresenceState: 'online',
        minimumSnapshotSequence: -1,
        dispatch,
        callbacks: callbacks(states),
        routeSignal: new AbortController().signal,
      }),
    TypeError,
  );
});
