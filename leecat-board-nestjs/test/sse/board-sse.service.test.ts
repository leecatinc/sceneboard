import assert from 'node:assert/strict';
import test from 'node:test';

import { BoardEventEnvelopeParserV1 } from '@leecat-board/board-schema';

import { BoardSseService } from '../../src/sse/board-sse.service.js';
import { SseResponseWriter } from '../../src/sse/sse-response-writer.js';

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
      revision: { revisionId: 'revision_1', revisionNumber: 1, createdAt: '2026-07-16T00:00:00.000Z' },
      originType: 'board.create',
      sourceRevisionId: null,
    },
  });
  assert.equal(event.ok, true);
  if (!event.ok) throw new Error('invalid event fixture');
  let closeListener: (() => void) | null = null;
  const request = {
    once: (_event: 'close', listener: () => void) => { closeListener = listener; },
    off: () => undefined,
  };
  const headers = new Map<string, string>();
  const chunks: Buffer[] = [];
  let ended = 0;
  const response = {
    statusCode: 0,
    headersSent: false,
    httpVersionMajor: 1,
    setHeader: (name: string, value: string) => { headers.set(name, value); },
    removeHeader: (name: string) => { headers.delete(name); },
    flushHeaders: () => { response.headersSent = true; },
    write: (chunk: Uint8Array) => {
      chunks.push(Buffer.from(chunk));
      if (chunks.length === 2) (closeListener as unknown as () => void)();
      return true;
    },
    once: () => undefined,
    off: () => undefined,
    end: () => { ended += 1; },
  };
  let unsubscribed = 0;
  let presenceClosed = 0;
  const service = new BoardSseService(
    {
      prepare: async () => ({
        sequence: 1,
        frames: [{ envelope: event.data.value, canonicalBytes: event.data.canonicalBytes, cursor: 'cursor_1' }],
      }),
      reauthorize: async () => 1,
      rangeAfter: async () => [],
    } as never,
    { subscribeBoard: async () => async () => { unsubscribed += 1; } } as never,
    new SseResponseWriter(),
    {
      open: async (input: unknown) => input,
      aggregate: async () => ({ version: 1, presence: [] }),
      touch: async () => true,
      close: async () => { presenceClosed += 1; return true; },
    } as never,
    { generatePublicIdV1: () => 'presence_event_1' } as never,
  );
  await service.stream({
    principal: {
      kind: 'user',
      actor: { principalKind: 'user', principalId: 'user_1', grantId: null, scopes: ['board.read'] },
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
  assert.doesNotMatch(chunks[1]?.toString('utf8') ?? '', /\nid:/u);
  assert.match(chunks[1]?.toString('utf8') ?? '', /"type":"presence.updated"/u);
  assert.equal(unsubscribed, 1);
  assert.equal(presenceClosed, 1);
  assert.equal(ended, 1);
});
