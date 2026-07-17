import assert from 'node:assert/strict';
import test from 'node:test';

import type { BoardId, EventId } from '@leecat-board/board-schema';

import { encodeDurableBoardEventHintV1, parseDurableBoardEventHintV1 } from '../../src/events/board-event-hint.js';
import { OutboxDispatcherService } from '../../src/events/outbox-dispatcher.service.js';
import { RedisEventFanoutService } from '../../src/events/redis-event-fanout.service.js';
import { RedisStreamKeyspace } from '../../src/redis/redis-stream-keyspace.js';

const BOARD_ID = '11111111-1111-4111-8111-111111111111' as BoardId;
const EVENT_ID = '33333333-3333-4333-8333-333333333333' as EventId;

test('publishes only after a lease-winner row load and marks after publish, including zero subscribers', async () => {
  const calls: string[] = [];
  const delivery = {
    listPendingCandidates: async () => [{ eventPk: 9n, eventId: EVENT_ID }],
    loadPendingEvent: async () => {
      calls.push('load');
      return { eventPk: 9n, eventId: EVENT_ID, boardId: BOARD_ID, sequence: 7 };
    },
    markDelivered: async () => {
      calls.push('mark');
      return true;
    },
  };
  const redis = {
    tryAcquireLease: async (key: string, ttl: number) => {
      calls.push('lease');
      assert.match(key, /^leecat_board:stream:dispatch:v1:[A-Za-z0-9_-]{22}$/u);
      assert.equal(ttl, 10_000);
      return true;
    },
    publish: async (_channel: string, message: string) => {
      calls.push('publish');
      assert.equal(parseDurableBoardEventHintV1(message, keyspace.boardFingerprint(BOARD_ID))?.sequence, 7);
      return 0;
    },
  };
  const keyspace = new RedisStreamKeyspace(Buffer.alloc(32, 7));
  const dispatcher = new OutboxDispatcherService(delivery as never, redis as never, keyspace);
  const result = await dispatcher.dispatchOnce();
  assert.deepEqual(calls, ['lease', 'load', 'publish', 'mark']);
  assert.deepEqual(result, { candidates: 1, leaseWins: 1, published: 1, markedDelivered: 1, failures: 0 });
});

test('a lost lease never loads payload and publish failure leaves the row pending', async () => {
  let loads = 0;
  let marks = 0;
  const delivery = {
    listPendingCandidates: async () => [
      { eventPk: 1n, eventId: EVENT_ID },
      { eventPk: 2n, eventId: '44444444-4444-4444-8444-444444444444' },
    ],
    loadPendingEvent: async (candidate: { eventPk: bigint }) => {
      loads += 1;
      return { eventPk: candidate.eventPk, eventId: EVENT_ID, boardId: BOARD_ID, sequence: 7 };
    },
    markDelivered: async () => {
      marks += 1;
      return true;
    },
  };
  let leases = 0;
  const redis = {
    tryAcquireLease: async () => (leases += 1) === 2,
    publish: async () => { throw new Error('unavailable'); },
  };
  const dispatcher = new OutboxDispatcherService(
    delivery as never,
    redis as never,
    new RedisStreamKeyspace(Buffer.alloc(32, 8)),
  );
  const result = await dispatcher.dispatchOnce();
  assert.equal(loads, 1);
  assert.equal(marks, 0);
  assert.equal(result.failures, 1);
  assert.equal(result.published, 0);
});

test('fanout shares one board subscription and rejects malformed or cross-board hints', async () => {
  let subscribed = 0;
  let unsubscribed = 0;
  let transportListener: ((message: string) => void) | null = null;
  const redis = {
    subscribe: async (_channel: string, listener: (message: string) => void) => {
      subscribed += 1;
      transportListener = listener;
      return async () => { unsubscribed += 1; };
    },
  };
  const keyspace = new RedisStreamKeyspace(Buffer.alloc(32, 9));
  const fanout = new RedisEventFanoutService(redis as never, keyspace);
  const received: number[] = [];
  const removeOne = await fanout.subscribeBoard(BOARD_ID, (hint) => {
    if (hint.kind === 'durable') received.push(hint.sequence);
  });
  const removeTwo = await fanout.subscribeBoard(BOARD_ID, (hint) => {
    if (hint.kind === 'durable') received.push(hint.sequence * 10);
  });
  assert.equal(subscribed, 1);
  assert.ok(transportListener !== null);
  const emit = transportListener as unknown as (message: string) => void;
  emit('{"kind":"durable"}');
  emit(encodeDurableBoardEventHintV1('AAAAAAAAAAAAAAAAAAAAAA', EVENT_ID, 1));
  emit(encodeDurableBoardEventHintV1(keyspace.boardFingerprint(BOARD_ID), EVENT_ID, 2));
  assert.deepEqual(received, [2, 20]);
  await removeOne();
  assert.equal(unsubscribed, 0);
  await removeTwo();
  assert.equal(unsubscribed, 1);
});

test('hint parser requires canonical exact fields and expected fingerprint', () => {
  const keyspace = new RedisStreamKeyspace(Buffer.alloc(32, 10));
  const boardFp = keyspace.boardFingerprint(BOARD_ID);
  const encoded = encodeDurableBoardEventHintV1(boardFp, EVENT_ID, 1);
  assert.deepEqual(parseDurableBoardEventHintV1(encoded, boardFp), {
    v: 1,
    kind: 'durable',
    boardFp,
    eventId: EVENT_ID,
    sequence: 1,
  });
  assert.equal(parseDurableBoardEventHintV1(`${encoded}\n`, boardFp), null);
  assert.equal(parseDurableBoardEventHintV1(encoded.replace('"v":1', '"v":1,"v":1'), boardFp), null);
});
