import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import test from 'node:test';

import { BoardEventEnvelopeParserV1 } from '@leecat-board/board-schema';

import { parsePublicUuidV4 } from '../../src/common/ids/public-uuid.storage.js';
import { BoardEventOutboxRepository } from '../../src/events/board-event-outbox.repository.js';

const BOARD_ID = '11111111-1111-4111-8111-111111111111';
const REVISION_ID = '22222222-2222-4222-8222-222222222222';
const EVENT_ID = '33333333-3333-4333-8333-333333333333';

const eventBytes = (sequence = 1): Buffer => {
  const parsed = BoardEventEnvelopeParserV1.parse({
    protocolVersion: 1,
    type: 'board.event',
    boardId: BOARD_ID,
    eventId: EVENT_ID,
    sequence,
    occurredAt: '2026-07-16T14:00:00.000Z',
    revisionId: REVISION_ID,
    data: {
      type: 'board.revision.created',
      revision: {
        revisionId: REVISION_ID,
        revisionNumber: 1,
        createdAt: '2026-07-16T14:00:00.000Z',
      },
      originType: 'board.create',
      sourceRevisionId: null,
    },
  });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) throw new Error('invalid event fixture');
  return Buffer.from(parsed.data.canonicalBytes);
};

const row = (sequence = 1) => {
  const payload = eventBytes(sequence);
  return {
    eventPk: '9',
    eventId: Buffer.from(parsePublicUuidV4(EVENT_ID)),
    boardId: BOARD_ID,
    revisionId: Buffer.from(parsePublicUuidV4(REVISION_ID)),
    sequenceNumber: String(sequence),
    eventType: 'board.revision.created',
    eventPayload: payload,
    eventCanonicalBytes: payload.byteLength,
    eventSha256: createHash('sha256').update(payload).digest(),
  };
};

test('uses a narrow pending candidate projection before the guarded full-row read', async () => {
  const queries: string[] = [];
  const connection = {
    query: async (sql: string) => {
      queries.push(sql);
      if (sql.includes('FROM board_event_outbox FORCE INDEX')) {
        return [[{ eventPk: '9', eventId: Buffer.from(parsePublicUuidV4(EVENT_ID)) }]];
      }
      return [[row()]];
    },
  };
  const repository = new BoardEventOutboxRepository({
    withConnection: async (apply: (value: typeof connection) => Promise<unknown>) => apply(connection),
  } as never);
  const candidates = await repository.listPendingCandidates();
  assert.deepEqual(candidates, [{ eventPk: 9n, eventId: EVENT_ID }]);
  assert.equal(/event_payload/u.test(queries[0] ?? ''), false);
  const event = await repository.loadPendingEvent(candidates[0]!);
  assert.equal(event?.sequence, 1);
  assert.equal(event?.boardId, BOARD_ID);
  assert.equal(event?.eventId, EVENT_ID);
  assert.match(queries[1] ?? '', /o\.event_pk = \? AND o\.event_id = \? AND o\.status_code = 'P'/u);
  assert.match(queries[1] ?? '', /b\.public_id AS boardId/u);
});

test('requires contiguous range rows and validates every stored digest/correlation', async () => {
  const valid = row();
  const gap = row(3);
  let rows = [valid];
  const connection = { query: async () => [rows] };
  const repository = new BoardEventOutboxRepository({
    withConnection: async (apply: (value: typeof connection) => Promise<unknown>) => apply(connection),
  } as never);
  assert.equal((await repository.listContiguousEvents(BOARD_ID as never, 0)).length, 1);
  rows = [gap];
  await assert.rejects(() => repository.listContiguousEvents(BOARD_ID as never, 0), /contiguous/u);

  const corrupt = row();
  corrupt.eventSha256 = Buffer.alloc(32);
  rows = [corrupt];
  await assert.rejects(() => repository.listContiguousEvents(BOARD_ID as never, 0), /integrity/u);
});

test('marks delivery only through a conditional pending transition', async () => {
  let sql = '';
  const connection = {
    execute: async (value: string) => {
      sql = value;
      return [{ affectedRows: 1 }];
    },
  };
  const repository = new BoardEventOutboxRepository({
    withConnection: async (apply: (value: typeof connection) => Promise<unknown>) => apply(connection),
  } as never);
  assert.equal(await repository.markDelivered(9n), true);
  assert.match(sql, /WHERE event_pk = \? AND status_code = 'P'/u);
  assert.match(sql, /INTERVAL 30 DAY/u);
});
