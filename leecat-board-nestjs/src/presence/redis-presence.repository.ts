import { Inject, Injectable } from '@nestjs/common';
import {
  type ActorContextV1,
  type BoardId,
  type PresenceSummaryV1,
  type PrincipalId,
  type TabId,
  type TimestampV1,
} from '@leecat-board/board-schema';

import { CryptoService } from '../common/security/crypto.service.js';
import { encodePresenceBoardEventHintV1 } from '../events/board-event-hint.js';
import { RedisStreamKeyspace } from '../redis/redis-stream-keyspace.js';
import { RedisService } from '../redis/redis.service.js';
import type { BrowserPresenceStatusReaderV1 } from './authorized-browser-presence.service.js';

const OPEN_SCRIPT = `-- leecat-board presence open v1
local now = tonumber(ARGV[1])
local expiry = tonumber(ARGV[2])
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', now)
redis.call('ZREMRANGEBYSCORE', KEYS[4], '-inf', now)
local prior = redis.call('GET', KEYS[1])
if not prior and redis.call('ZCARD', KEYS[4]) >= 8 then return {-1, 0} end
if not prior then
  local members = redis.call('ZRANGE', KEYS[2], 0, -1)
  local seen = {}
  local count = 0
  for i = 1, #members do
    local principal = string.match(members[i], ':([A-Za-z0-9_-]+):[A-Za-z0-9_-]+$')
    if principal and not seen[principal] then seen[principal] = true; count = count + 1 end
  end
  if not seen[ARGV[5]] and count >= 500 then return {-2, 0} end
end
redis.call('SET', KEYS[1], ARGV[3], 'PX', 35000)
redis.call('ZADD', KEYS[2], expiry, KEYS[1])
redis.call('PEXPIRE', KEYS[2], 70000)
redis.call('ZADD', KEYS[4], expiry, KEYS[1])
redis.call('PEXPIRE', KEYS[4], 70000)
redis.call('ZADD', KEYS[5], expiry, ARGV[4])
redis.call('PEXPIRE', KEYS[5], 70000)
local version = redis.call('INCR', KEYS[3])
redis.call('PEXPIRE', KEYS[3], 70000)
return {version, 1}`;

const TOUCH_SCRIPT = `-- leecat-board presence touch v1
local current = redis.call('GET', KEYS[1])
if not current or string.sub(current, 1, string.len(ARGV[1]) + 1) ~= ARGV[1] .. '|' then return 0 end
redis.call('SET', KEYS[1], ARGV[2], 'PX', 35000)
redis.call('ZADD', KEYS[2], ARGV[3], KEYS[1])
redis.call('PEXPIRE', KEYS[2], 70000)
redis.call('ZADD', KEYS[3], ARGV[3], KEYS[1])
redis.call('PEXPIRE', KEYS[3], 70000)
return 1`;

const CLOSE_SCRIPT = `-- leecat-board presence close v1
local current = redis.call('GET', KEYS[1])
if not current or string.sub(current, 1, string.len(ARGV[1]) + 1) ~= ARGV[1] .. '|' then return 0 end
redis.call('DEL', KEYS[1])
redis.call('ZREM', KEYS[2], KEYS[1])
redis.call('ZREM', KEYS[4], KEYS[1])
local version = redis.call('INCR', KEYS[3])
redis.call('PEXPIRE', KEYS[3], 70000)
return version`;

const AGGREGATE_SCRIPT = `-- leecat-board presence aggregate v1
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
local members = redis.call('ZRANGE', KEYS[1], 0, -1)
local output = {redis.call('GET', KEYS[2]) or '0'}
if #members == 0 then return output end
local values = redis.call('MGET', unpack(members))
for i = 1, #values do if values[i] then table.insert(output, values[i]) end end
return output`;

const STATUS_SCRIPT = `-- leecat-board presence status v1
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
if redis.call('ZCARD', KEYS[1]) > 0 then return 1 else return 0 end`;

export type RedisPresenceHandleV1 = Readonly<{
  boardId: BoardId;
  ownerUserPk: bigint;
  tabId: TabId;
  connectionId: string;
  actor: ActorContextV1;
  state: 'online' | 'away';
}>;

export type PresenceAggregateV1 = {
  version: number;
  presence: readonly PresenceSummaryV1[];
};

const safeVersion = (value: unknown): number => {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^(?:0|[1-9][0-9]*)$/u.test(value))) {
    throw new Error('invalid Redis presence version');
  }
  const version = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(version) || version < 0) throw new Error('invalid Redis presence version');
  return version;
};

const record = (handle: RedisPresenceHandleV1, now: number): string => (
  [handle.connectionId, handle.actor.principalKind, handle.actor.principalId, handle.state, String(now)].join('|')
);

@Injectable()
export class RedisPresenceRepository implements BrowserPresenceStatusReaderV1 {
  constructor(
    @Inject(RedisService) private readonly redis: RedisService,
    @Inject(RedisStreamKeyspace) private readonly keyspace: RedisStreamKeyspace,
    @Inject(CryptoService) private readonly crypto: CryptoService,
  ) {}

  async open(input: {
    boardId: BoardId;
    ownerUserPk: bigint;
    tabId: TabId;
    actor: ActorContextV1;
    state: 'online' | 'away';
  }): Promise<RedisPresenceHandleV1> {
    const handle = Object.freeze({ ...input, connectionId: this.crypto.randomBase64Url(16) });
    const now = Date.now();
    const boardFp = this.keyspace.boardFingerprint(input.boardId);
    const result = await this.redis.evaluate(OPEN_SCRIPT, [
      this.keyspace.presenceConnectionKey(input.boardId, input.ownerUserPk, input.tabId),
      this.keyspace.presenceIndexKey(input.boardId),
      this.keyspace.presenceVersionKey(input.boardId),
      this.keyspace.presenceConcurrencyKey(input.boardId, input.ownerUserPk),
      this.keyspace.presenceActiveKey(),
    ], [
      String(now), String(now + 35_000), record(handle, now), boardFp,
      this.keyspace.principalFingerprint(input.ownerUserPk),
    ]);
    if (!Array.isArray(result) || Number(result[0]) < 1) throw new Error('presence connection cap reached');
    const version = safeVersion(result[0]);
    await this.#publishVersion(input.boardId, version);
    return handle;
  }

  async touch(handle: RedisPresenceHandleV1): Promise<boolean> {
    const now = Date.now();
    const value = await this.redis.evaluate(TOUCH_SCRIPT, [
      this.keyspace.presenceConnectionKey(handle.boardId, handle.ownerUserPk, handle.tabId),
      this.keyspace.presenceIndexKey(handle.boardId),
      this.keyspace.presenceConcurrencyKey(handle.boardId, handle.ownerUserPk),
    ], [handle.connectionId, record(handle, now), String(now + 35_000)]);
    return Number(value) === 1;
  }

  async close(handle: RedisPresenceHandleV1): Promise<boolean> {
    const result = await this.redis.evaluate(CLOSE_SCRIPT, [
      this.keyspace.presenceConnectionKey(handle.boardId, handle.ownerUserPk, handle.tabId),
      this.keyspace.presenceIndexKey(handle.boardId),
      this.keyspace.presenceVersionKey(handle.boardId),
      this.keyspace.presenceConcurrencyKey(handle.boardId, handle.ownerUserPk),
    ], [handle.connectionId]);
    const version = safeVersion(result);
    if (version === 0) return false;
    await this.#publishVersion(handle.boardId, version);
    return true;
  }

  async aggregate(boardId: BoardId): Promise<PresenceAggregateV1> {
    const result = await this.redis.evaluate(AGGREGATE_SCRIPT, [
      this.keyspace.presenceIndexKey(boardId),
      this.keyspace.presenceVersionKey(boardId),
    ], [String(Date.now())]);
    if (!Array.isArray(result) || result.length > 4_001) throw new Error('invalid Redis presence aggregate');
    const version = safeVersion(result[0]);
    const strongest = new Map<string, PresenceSummaryV1>();
    for (const value of result.slice(1)) {
      if (typeof value !== 'string') throw new Error('invalid Redis presence record');
      const parts = value.split('|');
      if (parts.length !== 5) throw new Error('invalid Redis presence record');
      const [connectionId, principalKind, principalId, state, lastSeenSource] = parts;
      if (!/^[A-Za-z0-9_-]{22}$/u.test(connectionId ?? '')
        || (principalKind !== 'user' && principalKind !== 'mcp_client' && principalKind !== 'service')
        || !/^[A-Za-z0-9_-]{1,128}$/u.test(principalId ?? '')
        || (state !== 'online' && state !== 'away')
        || !/^(?:0|[1-9][0-9]*)$/u.test(lastSeenSource ?? '')) throw new Error('invalid Redis presence record');
      const lastSeen = Number(lastSeenSource);
      if (!Number.isSafeInteger(lastSeen)) throw new Error('invalid Redis presence time');
      const summary: PresenceSummaryV1 = {
        principal: { principalKind, principalId: principalId as PrincipalId },
        state,
        lastSeenAt: new Date(lastSeen).toISOString() as TimestampV1,
      };
      const key = `${principalKind}\0${principalId}`;
      const current = strongest.get(key);
      if (current === undefined) {
        strongest.set(key, summary);
      } else {
        strongest.set(key, {
          principal: current.principal,
          state: current.state === 'online' || summary.state === 'online' ? 'online' : 'away',
          lastSeenAt: current.lastSeenAt > summary.lastSeenAt ? current.lastSeenAt : summary.lastSeenAt,
        });
      }
    }
    const presence = [...strongest.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([, value]) => value);
    return { version, presence };
  }

  async getStatus(input: { boardId: BoardId; ownerUserPk: bigint }): Promise<'online' | 'offline' | 'unknown'> {
    try {
      const result = await this.redis.evaluate(STATUS_SCRIPT, [
        this.keyspace.presenceConcurrencyKey(input.boardId, input.ownerUserPk),
      ], [String(Date.now())]);
      if (Number(result) === 1) return 'online';
      if (Number(result) === 0) return 'offline';
      return 'unknown';
    } catch {
      return 'unknown';
    }
  }

  async #publishVersion(boardId: BoardId, version: number): Promise<void> {
    const boardFp = this.keyspace.boardFingerprint(boardId);
    await this.redis.publish(
      this.keyspace.boardHintChannel(boardId),
      encodePresenceBoardEventHintV1(boardFp, version),
    );
  }
}
