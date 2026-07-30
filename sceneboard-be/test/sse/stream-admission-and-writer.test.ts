import assert from 'node:assert/strict';
import test from 'node:test';

import { BoardEventEnvelopeParserV1 } from '@sceneboard/board-schema';

import { SseResponseWriter } from '../../src/sse/sse-response-writer.js';
import { StreamAdmissionGuard } from '../../src/sse/stream-admission.guard.js';

const makeContext = (request: Record<string, unknown>) => ({
  getHandler: () => function handler() {},
  getClass: () => class Controller {},
  switchToHttp: () => ({ getRequest: () => request }),
});

const request = () => ({
  method: 'GET',
  headers: {
    accept: 'application/json, text/event-stream; q=1',
    'last-event-id': 'opaque_cursor',
    'content-length': '0',
  },
  params: { boardId: 'board_1' },
  query: { tabId: 'AAAAAAAAAAAAAAAAAAAAAA', presenceState: 'online' },
});

test('stream admission accepts only the exact browser fetch shape', () => {
  const guard = new StreamAdmissionGuard({ getAllAndOverride: () => true } as never);
  const valid = request();
  assert.equal(guard.canActivate(makeContext(valid) as never), true);
  assert.deepEqual(
    (valid as typeof valid & { boardStreamAdmission: unknown }).boardStreamAdmission,
    {
      boardId: 'board_1',
      tabId: 'AAAAAAAAAAAAAAAAAAAAAA',
      presenceState: 'online',
      cursor: 'opaque_cursor',
      documentSchemaVersion: 1,
    },
  );
  const v2 = request();
  v2.query = { ...v2.query, documentSchemaVersion: '2' } as never;
  assert.equal(guard.canActivate(makeContext(v2) as never), true);
  assert.equal(
    (v2 as typeof v2 & { boardStreamAdmission: { documentSchemaVersion: number } })
      .boardStreamAdmission.documentSchemaVersion,
    2,
  );
  for (const version of ['1', '3'] as const) {
    const admitted = request();
    admitted.query = { ...admitted.query, documentSchemaVersion: version } as never;
    assert.equal(guard.canActivate(makeContext(admitted) as never), true);
    assert.equal(
      (
        admitted as typeof admitted & {
          boardStreamAdmission: { documentSchemaVersion: number };
        }
      ).boardStreamAdmission.documentSchemaVersion,
      Number(version),
    );
  }

  for (const mutate of [
    (value: ReturnType<typeof request>) => {
      value.headers.accept = 'application/json';
    },
    (value: ReturnType<typeof request>) => {
      Object.assign(value.headers, { authorization: 'Bearer secret' });
    },
    (value: ReturnType<typeof request>) => {
      value.query = { ...value.query, extra: 'x' } as never;
    },
    (value: ReturnType<typeof request>) => {
      value.query = { ...value.query, tabId: ['a', 'b'] } as never;
    },
    (value: ReturnType<typeof request>) => {
      value.query = { ...value.query, documentSchemaVersion: '4' } as never;
    },
    (value: ReturnType<typeof request>) => {
      value.query = { ...value.query, documentSchemaVersion: ['2', '2'] } as never;
    },
    (value: ReturnType<typeof request>) => {
      value.headers['last-event-id'] = 'bad\nvalue';
    },
    (value: ReturnType<typeof request>) => {
      value.headers['content-length'] = '1';
    },
  ]) {
    const invalid = request();
    mutate(invalid);
    assert.throws(() => guard.canActivate(makeContext(invalid) as never));
  }
});

test('server writer emits the exact event and keepalive wire grammar', async () => {
  const parsed = BoardEventEnvelopeParserV1.parse({
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
  assert.equal(parsed.ok, true);
  if (!parsed.ok) throw new Error('invalid event fixture');
  const writer = new SseResponseWriter();
  const chunks: Uint8Array[] = [];
  const response = {
    write: (chunk: Uint8Array) => {
      chunks.push(chunk);
      return true;
    },
    once: () => undefined,
    off: () => undefined,
  };
  await writer.write(response, writer.encodeEvent(parsed.data.canonicalBytes, 'opaque_cursor'));
  await writer.write(response, writer.encodeKeepalive());
  const eventText = Buffer.from(chunks[0]!).toString('utf8');
  assert.match(eventText, /^event: board\.event\.v1\nid: opaque_cursor\ndata: /u);
  assert.match(eventText, /\n\n$/u);
  const data = eventText.split('\ndata: ')[1]?.slice(0, -2);
  assert.equal(typeof data, 'string');
  const roundTrip = BoardEventEnvelopeParserV1.parseBytes(Buffer.from(data ?? '', 'utf8'));
  assert.equal(roundTrip.ok, true);
  assert.equal(roundTrip.ok ? roundTrip.data.value.eventId : null, 'event_1');
  assert.equal(Buffer.from(chunks[1]!).toString('ascii'), ': leecat-board-keepalive\n\n');
});

test('writer waits for drain before resolving a backpressured frame', async () => {
  const writer = new SseResponseWriter();
  let drain: (() => void) | null = null;
  const pending = writer.write(
    {
      write: () => false,
      once: (_event, listener) => {
        drain = listener;
      },
      off: () => undefined,
    },
    new Uint8Array([1]),
  );
  let settled = false;
  void pending.then(() => {
    settled = true;
  });
  await Promise.resolve();
  assert.equal(settled, false);
  const release = drain as unknown as () => void;
  release();
  await pending;
  assert.equal(settled, true);
});
