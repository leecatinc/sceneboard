import assert from 'node:assert/strict';
import test from 'node:test';

import type { BoardId, EventId, TimestampV1 } from '@leecat-board/board-schema';

import { BoardContractError } from '../../src/common/errors/app-error.js';
import { RedisStreamKeyspace } from '../../src/redis/redis-stream-keyspace.js';
import { SseCursorCodec } from '../../src/sse/sse-cursor.codec.js';

const codec = (): SseCursorCodec => new SseCursorCodec(
  new RedisStreamKeyspace(Buffer.alloc(32, 5)),
);

test('round-trips one canonical signed event cursor without exposing raw event identity as the ID', () => {
  const value = {
    v: 1 as const,
    k: 'event' as const,
    b: 'board_1' as BoardId,
    s: 42,
    e: 'event_42' as EventId,
    t: '2026-07-16T14:00:00.000Z' as TimestampV1,
  };
  const cursor = codec().encode(value);
  assert.match(cursor, /^lcbse_v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
  assert.ok(cursor.length <= 512);
  assert.deepEqual(codec().decode(cursor), value);
  assert.equal(cursor.includes('event_42'), false);
});

test('rejects framing, canonical payload, and MAC tampering before use', () => {
  const value = {
    v: 1 as const,
    k: 'snapshot' as const,
    b: 'board_1' as BoardId,
    s: 1,
    e: 'sse_snapshot_abcdefghijklmnopqrstuv' as EventId,
    t: '2026-07-16T14:00:00.000Z' as TimestampV1,
  };
  const cursor = codec().encode(value);
  const invalid = [
    cursor.replace('lcbse_v1', 'lcbse_v2'),
    `${cursor}x`,
    cursor.slice(0, -1) + (cursor.endsWith('A') ? 'B' : 'A'),
    'lcbse_v1.bad.bad',
  ];
  for (const item of invalid) assert.throws(() => codec().decode(item), BoardContractError);
});

test('pins inclusive fifteen-minute past and thirty-second future usability', () => {
  const now = Date.parse('2026-07-16T14:15:00.000Z');
  const create = (time: string) => ({
    v: 1 as const,
    k: 'event' as const,
    b: 'board_1' as BoardId,
    s: 1,
    e: 'event_1' as EventId,
    t: time as TimestampV1,
  });
  const value = codec();
  assert.equal(value.isTimeUsable(create('2026-07-16T14:00:00.000Z'), now), true);
  assert.equal(value.isTimeUsable(create('2026-07-16T13:59:59.999Z'), now), false);
  assert.equal(value.isTimeUsable(create('2026-07-16T14:15:30.000Z'), now), true);
  assert.equal(value.isTimeUsable(create('2026-07-16T14:15:30.001Z'), now), false);
});

test('creates fresh snapshot IDs with the exact 16-byte public grammar', () => {
  const value = codec();
  const first = value.createSnapshotEventId();
  const second = value.createSnapshotEventId();
  assert.match(first, /^sse_snapshot_[A-Za-z0-9_-]{22}$/);
  assert.notEqual(first, second);
});
