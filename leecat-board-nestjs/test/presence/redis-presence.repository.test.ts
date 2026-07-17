import assert from 'node:assert/strict';
import test from 'node:test';

import type { BoardId, TabId } from '@leecat-board/board-schema';

import { parseBoardEventHintV1 } from '../../src/events/board-event-hint.js';
import { RedisPresenceRepository } from '../../src/presence/redis-presence.repository.js';
import { RedisStreamKeyspace } from '../../src/redis/redis-stream-keyspace.js';

const BOARD_ID = 'board_1' as BoardId;
const TAB_ID = 'AAAAAAAAAAAAAAAAAAAAAA' as TabId;

test('open, touch, and compare-delete close use bounded TTL scripts and version hints', async () => {
  const evaluations: Array<{ script: string; keys: readonly string[]; args: readonly string[] }> = [];
  const publications: Array<{ channel: string; message: string }> = [];
  let step = 0;
  const redis = {
    evaluate: async (script: string, keys: readonly string[], args: readonly string[]) => {
      evaluations.push({ script, keys, args });
      step += 1;
      return step === 1 ? [3, 1] : step === 2 ? 1 : 4;
    },
    publish: async (channel: string, message: string) => {
      publications.push({ channel, message });
      return 0;
    },
  };
  const keyspace = new RedisStreamKeyspace(Buffer.alloc(32, 16));
  const repository = new RedisPresenceRepository(
    redis as never,
    keyspace,
    { randomBase64Url: () => 'BBBBBBBBBBBBBBBBBBBBBB' } as never,
  );
  const handle = await repository.open({
    boardId: BOARD_ID,
    ownerUserPk: 1n,
    tabId: TAB_ID,
    actor: { principalKind: 'user', principalId: 'user_1' as never, grantId: null, scopes: ['board.read'] },
    state: 'online',
  });
  assert.equal(handle.connectionId, 'BBBBBBBBBBBBBBBBBBBBBB');
  assert.match(evaluations[0]?.script ?? '', /presence open v1/u);
  assert.equal(Number(evaluations[0]?.args[1]) - Number(evaluations[0]?.args[0]), 35_000);
  assert.equal(evaluations[0]?.keys.some((key) => key.includes(BOARD_ID)), false);
  assert.equal(publications.length, 1);
  assert.equal(parseBoardEventHintV1(publications[0]!.message, keyspace.boardFingerprint(BOARD_ID))?.kind, 'presence');

  assert.equal(await repository.touch(handle), true);
  assert.match(evaluations[1]?.script ?? '', /presence touch v1/u);
  assert.equal(publications.length, 1);

  assert.equal(await repository.close(handle), true);
  assert.match(evaluations[2]?.script ?? '', /presence close v1/u);
  assert.equal(publications.length, 2);
});

test('aggregation is unique, online-dominant, latest-seen, and deterministically sorted', async () => {
  const redis = {
    evaluate: async () => [
      '9',
      'AAAAAAAAAAAAAAAAAAAAAA|user|user_2|away|1000',
      'BBBBBBBBBBBBBBBBBBBBBB|user|user_1|online|2000',
      'CCCCCCCCCCCCCCCCCCCCCC|user|user_1|away|3000',
    ],
    publish: async () => 0,
  };
  const repository = new RedisPresenceRepository(
    redis as never,
    new RedisStreamKeyspace(Buffer.alloc(32, 17)),
    {} as never,
  );
  const aggregate = await repository.aggregate(BOARD_ID);
  assert.equal(aggregate.version, 9);
  assert.deepEqual(aggregate.presence.map((item) => [item.principal.principalId, item.state, item.lastSeenAt]), [
    ['user_1', 'online', '1970-01-01T00:00:03.000Z'],
    ['user_2', 'away', '1970-01-01T00:00:01.000Z'],
  ]);
});

test('opaque status maps stable counts and Redis failures without exposing identifiers', async () => {
  let result: unknown = 1;
  const repository = new RedisPresenceRepository(
    { evaluate: async () => result } as never,
    new RedisStreamKeyspace(Buffer.alloc(32, 18)),
    {} as never,
  );
  assert.equal(await repository.getStatus({ boardId: BOARD_ID, ownerUserPk: 1n }), 'online');
  result = 0;
  assert.equal(await repository.getStatus({ boardId: BOARD_ID, ownerUserPk: 1n }), 'offline');
  result = 'invalid';
  assert.equal(await repository.getStatus({ boardId: BOARD_ID, ownerUserPk: 1n }), 'unknown');
});
