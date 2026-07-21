import assert from 'node:assert/strict';
import test from 'node:test';

import type { BoardId, EventId } from '@sceneboard/board-schema';

import { RedisStreamKeyspace } from '../../src/redis/redis-stream-keyspace.js';

test('derives deterministic purpose-separated fingerprints and exact physical names', () => {
  const source = Buffer.alloc(32, 7);
  const keyspace = new RedisStreamKeyspace(source);
  assert.equal(source.equals(Buffer.alloc(32)), true);
  const boardId = 'board_1' as BoardId;
  const eventId = 'event_1' as EventId;
  const board = keyspace.boardFingerprint(boardId);
  const event = keyspace.eventFingerprint(eventId);
  const principal = keyspace.principalFingerprint(1n);
  assert.match(board, /^[A-Za-z0-9_-]{22}$/);
  assert.match(event, /^[A-Za-z0-9_-]{22}$/);
  assert.match(principal, /^[A-Za-z0-9_-]{22}$/);
  assert.notEqual(board, event);
  assert.notEqual(board, principal);
  assert.equal(keyspace.boardFingerprint(boardId), board);
  assert.equal(keyspace.boardHintChannel(boardId), `sceneboard:stream:events:v1:${board}`);
  assert.equal(keyspace.eventLeaseKey(eventId), `sceneboard:stream:dispatch:v1:${event}`);
  assert.equal(
    keyspace.presenceConnectionKey(boardId, 1n, 'AAAAAAAAAAAAAAAAAAAAAA' as never),
    `sceneboard:stream:presence:v1:${board}:${principal}:AAAAAAAAAAAAAAAAAAAAAA`,
  );
  assert.equal(keyspace.presenceIndexKey(boardId), `sceneboard:stream:presence-index:v1:${board}`);
  assert.equal(
    keyspace.presenceConcurrencyKey(boardId, 1n),
    `sceneboard:stream:concurrency:v1:${board}:${principal}`,
  );
});

test('rejects a wrong key size, prefix drift, and owner IDs outside uint64', () => {
  assert.throws(() => new RedisStreamKeyspace(Buffer.alloc(31)), TypeError);
  assert.throws(() => new RedisStreamKeyspace(Buffer.alloc(32), 'other:'), TypeError);
  const keyspace = new RedisStreamKeyspace(Buffer.alloc(32, 8));
  assert.throws(() => keyspace.principalFingerprint(0n), TypeError);
  assert.throws(() => keyspace.principalFingerprint(0x1_0000_0000_0000_0000n), TypeError);
});
