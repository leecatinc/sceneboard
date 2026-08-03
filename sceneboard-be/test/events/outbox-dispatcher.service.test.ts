import assert from 'node:assert/strict';
import test from 'node:test';

import type { BoardId, EventId } from '@sceneboard/board-schema';

import {
  encodeDurableBoardEventHintV1,
  parseDurableBoardEventHintV1,
} from '../../src/events/board-event-hint.js';
import { BoardEventOutboxRepository } from '../../src/events/board-event-outbox.repository.js';
import { OutboxDispatcherService } from '../../src/events/outbox-dispatcher.service.js';
import { RedisEventFanoutService } from '../../src/events/redis-event-fanout.service.js';
import { parsePublicUuidV4 } from '../../src/common/ids/public-uuid.storage.js';
import { RedisStreamKeyspace } from '../../src/redis/redis-stream-keyspace.js';

const BOARD_ID = '11111111-1111-4111-8111-111111111111' as BoardId;
const EVENT_ID = '33333333-3333-4333-8333-333333333333' as EventId;

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

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
      assert.match(key, /^sceneboard:stream:dispatch:v1:[A-Za-z0-9_-]{22}$/u);
      assert.equal(ttl, 10_000);
      return true;
    },
    publish: async (_channel: string, message: string) => {
      calls.push('publish');
      assert.equal(
        parseDurableBoardEventHintV1(message, keyspace.boardFingerprint(BOARD_ID))?.sequence,
        7,
      );
      return 0;
    },
  };
  const keyspace = new RedisStreamKeyspace(Buffer.alloc(32, 7));
  const dispatcher = new OutboxDispatcherService(delivery as never, redis as never, keyspace);
  const result = await dispatcher.dispatchOnce();
  assert.deepEqual(calls, ['lease', 'load', 'publish', 'mark']);
  assert.deepEqual(result, {
    candidates: 1,
    leaseWins: 1,
    published: 1,
    markedDelivered: 1,
    failures: 0,
  });
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
    publish: async () => {
      throw new Error('unavailable');
    },
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

test('integrity-failed pending rows are deferred without marking them delivered', async () => {
  const laterEventId = '44444444-4444-4444-8444-444444444444' as EventId;
  const candidateQueries: Array<{ sql: string; parameters: readonly unknown[] }> = [];
  const connection = {
    async query(sql: string, parameters: readonly unknown[] = []) {
      if (sql.includes('FROM board_event_outbox FORCE INDEX')) {
        candidateQueries.push({ sql, parameters });
        return sql.includes('event_pk NOT IN')
          ? [[{ eventPk: '2', eventId: Buffer.from(parsePublicUuidV4(laterEventId)) }]]
          : [[{ eventPk: '1', eventId: Buffer.from(parsePublicUuidV4(EVENT_ID)) }]];
      }
      return [
        [
          {
            eventPk: '1',
            eventId: Buffer.from(parsePublicUuidV4(EVENT_ID)),
            boardId: BOARD_ID,
            revisionId: null,
            sequenceNumber: '1',
            eventType: 'board.revision.created',
            eventPayload: Buffer.from('corrupt'),
            eventCanonicalBytes: 8,
            eventSha256: Buffer.alloc(32),
          },
        ],
      ];
    },
  };
  const repository = new BoardEventOutboxRepository({
    withConnection: async (apply: (value: typeof connection) => Promise<unknown>) =>
      apply(connection),
  } as never);
  const corrupt = (await repository.listPendingCandidates())[0];
  assert.ok(corrupt !== undefined);
  await assert.rejects(repository.loadPendingEvent(corrupt), /integrity/u);
  const candidates = await repository.listPendingCandidates();
  assert.deepEqual(candidates, [{ eventPk: 2n, eventId: laterEventId }]);
  assert.match(candidateQueries[1]?.sql ?? '', /event_pk NOT IN \(\?\)/u);
  assert.deepEqual(candidateQueries[1]?.parameters, ['1', 100]);
  assert.equal((await repository.getHealth()).quarantinedCorruptPending, true);
});

test('fanout shares one board subscription and rejects malformed or cross-board hints', async () => {
  let subscribed = 0;
  let unsubscribed = 0;
  let transportListener: ((message: string) => void) | null = null;
  const redis = {
    subscribe: async (_channel: string, listener: (message: string) => void) => {
      subscribed += 1;
      transportListener = listener;
      return async () => {
        unsubscribed += 1;
      };
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

test('fanout single-flights concurrent setup and binds teardown to one generation', async () => {
  const setup = deferred<() => Promise<void>>();
  let subscribed = 0;
  let unsubscribed = 0;
  const redis = {
    subscribe: async () => {
      subscribed += 1;
      return setup.promise;
    },
  };
  const fanout = new RedisEventFanoutService(
    redis as never,
    new RedisStreamKeyspace(Buffer.alloc(32, 11)),
  );
  const first = fanout.subscribeBoard(BOARD_ID, () => undefined);
  const second = fanout.subscribeBoard(BOARD_ID, () => undefined);
  await Promise.resolve();
  assert.equal(subscribed, 1);
  setup.resolve(async () => {
    unsubscribed += 1;
  });
  const [removeFirst, removeSecond] = await Promise.all([first, second]);
  await removeSecond();
  assert.equal(unsubscribed, 0);
  await removeFirst();
  assert.equal(unsubscribed, 1);
});

test('fanout recovers from setup rejection and isolates listener failures', async () => {
  const firstSetup = deferred<() => Promise<void>>();
  let subscribed = 0;
  let transportListener: ((message: string) => void) | null = null;
  const redis = {
    subscribe: async (_channel: string, listener: (message: string) => void) => {
      subscribed += 1;
      transportListener = listener;
      if (subscribed === 1) return firstSetup.promise;
      return async () => undefined;
    },
  };
  const keyspace = new RedisStreamKeyspace(Buffer.alloc(32, 12));
  const fanout = new RedisEventFanoutService(redis as never, keyspace);
  const first = fanout.subscribeBoard(BOARD_ID, () => undefined);
  const second = fanout.subscribeBoard(BOARD_ID, () => undefined);
  firstSetup.reject(new Error('fixture setup failure'));
  await assert.rejects(first, /fixture setup failure/u);
  await assert.rejects(second, /fixture setup failure/u);
  assert.equal(subscribed, 1);

  const received: number[] = [];
  const removeThrowing = await fanout.subscribeBoard(BOARD_ID, () => {
    throw new Error('fixture listener failure');
  });
  const removeHealthy = await fanout.subscribeBoard(BOARD_ID, (hint) => {
    if (hint.kind === 'durable') received.push(hint.sequence);
  });
  assert.equal(subscribed, 2);
  assert.ok(transportListener !== null);
  const emit = transportListener as unknown as (message: string) => void;
  assert.doesNotThrow(() =>
    emit(encodeDurableBoardEventHintV1(keyspace.boardFingerprint(BOARD_ID), EVENT_ID, 3)),
  );
  assert.deepEqual(received, [3]);
  await removeThrowing();
  await removeHealthy();
});

test('fanout tears down a pending setup during module destruction', async () => {
  const setup = deferred<() => Promise<void>>();
  let unsubscribed = 0;
  const fanout = new RedisEventFanoutService(
    {
      subscribe: async () => setup.promise,
    } as never,
    new RedisStreamKeyspace(Buffer.alloc(32, 13)),
  );
  const subscription = fanout.subscribeBoard(BOARD_ID, () => undefined);
  await Promise.resolve();
  const destroyed = fanout.onModuleDestroy();
  setup.resolve(async () => {
    unsubscribed += 1;
  });
  await destroyed;
  await assert.rejects(subscription, /closed during setup/u);
  assert.equal(unsubscribed, 1);
});

test('fanout cancellation removes pending ownership and tears down the exact generation', async () => {
  const setup = deferred<() => Promise<void>>();
  let subscribed = 0;
  let unsubscribed = 0;
  const fanout = new RedisEventFanoutService(
    {
      subscribe: async () => {
        subscribed += 1;
        return subscribed === 1
          ? setup.promise
          : async () => {
              unsubscribed += 1;
            };
      },
    } as never,
    new RedisStreamKeyspace(Buffer.alloc(32, 15)),
  );
  const cancellation = new AbortController();
  const pending = fanout.subscribeBoard(BOARD_ID, () => undefined, cancellation.signal);
  await Promise.resolve();
  cancellation.abort();
  setup.resolve(async () => {
    unsubscribed += 1;
  });
  await assert.rejects(pending, /closed during setup/u);
  assert.equal(unsubscribed, 1);
  const removeFresh = await fanout.subscribeBoard(BOARD_ID, () => undefined);
  await removeFresh();
  assert.equal(subscribed, 2);
  assert.equal(unsubscribed, 2);
});

test('fanout isolates teardown rejection and permits a fresh generation', async () => {
  let subscribed = 0;
  let teardownAttempts = 0;
  const fanout = new RedisEventFanoutService(
    {
      async subscribe() {
        subscribed += 1;
        return async () => {
          teardownAttempts += 1;
          if (subscribed === 1) throw new Error('fixture teardown failure');
        };
      },
    } as never,
    new RedisStreamKeyspace(Buffer.alloc(32, 14)),
  );
  const removeFirst = await fanout.subscribeBoard(BOARD_ID, () => undefined);
  await assert.rejects(removeFirst(), /fixture teardown failure/u);
  const removeSecond = await fanout.subscribeBoard(BOARD_ID, () => undefined);
  await removeSecond();
  assert.equal(subscribed, 2);
  assert.equal(teardownAttempts, 2);
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
  assert.equal(
    parseDurableBoardEventHintV1(encoded.replace('"v":1', '"v":1,"v":1'), boardFp),
    null,
  );
});
