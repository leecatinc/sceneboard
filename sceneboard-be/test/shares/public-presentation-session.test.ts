import assert from 'node:assert/strict';
import test from 'node:test';

import type { PageId } from '@sceneboard/board-schema';

import type { StoredPublicContext } from '../../src/shares/public-context.store.js';
import { PublicPresentationSessionService } from '../../src/shares/public-presentation-session.service.js';
import { PublicShareHttpError } from '../../src/shares/public-share.error.js';

const contextId = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const pageId = 'page_1234567890123456789012' as PageId;
const now = new Date('2026-08-05T06:00:00.000Z');

class SessionRedisFake {
  readonly sessions = new Map<string, string>();
  readonly indexes = new Map<string, Map<string, number>>();
  readonly published: Array<{ channel: string; message: string }> = [];
  publishError: Error | null = null;

  async evaluate(
    script: string,
    keys: readonly string[],
    args: readonly string[],
  ): Promise<unknown> {
    if (script.includes("return 'CAP'")) {
      const [indexKey, sessionKey] = keys as readonly [string, string];
      const [nowValue, prefix, limit, json, expiresAt, sessionId, hardExpiresAt] = args;
      const index = this.indexes.get(indexKey) ?? new Map<string, number>();
      this.indexes.set(indexKey, index);
      for (const [id, expiry] of index)
        if (expiry <= Number(nowValue)) {
          index.delete(id);
          this.sessions.delete(`${prefix}${id}`);
        }
      if (index.size >= Number(limit)) return 'CAP';
      if (this.sessions.has(sessionKey)) return 'COLLISION';
      this.sessions.set(sessionKey, json!);
      index.set(sessionId!, Number(expiresAt));
      assert.ok(Number(hardExpiresAt) >= Number(expiresAt));
      return json;
    }
    if (script.includes("redis.call('ZRANGE'")) {
      const [indexKey] = keys;
      const [nowValue, prefix] = args;
      const index = this.indexes.get(indexKey!) ?? new Map<string, number>();
      const values: string[] = [];
      for (const [id, expiry] of index) {
        if (expiry <= Number(nowValue)) {
          index.delete(id);
          this.sessions.delete(`${prefix}${id}`);
          continue;
        }
        const value = this.sessions.get(`${prefix}${id}`);
        if (value === undefined) index.delete(id);
        else values.push(value);
      }
      return values;
    }
    if (script.includes("return 'CONFLICT'")) {
      const [sessionKey, indexKey] = keys as readonly [string, string];
      const [expectedVersion, json, expiresAt, sessionId] = args;
      const raw = this.sessions.get(sessionKey);
      if (raw === undefined) return 'MISSING';
      if (JSON.parse(raw).version !== Number(expectedVersion)) return 'CONFLICT';
      this.sessions.set(sessionKey, json!);
      this.indexes.get(indexKey)?.set(sessionId!, Number(expiresAt));
      return json;
    }
    if (script.includes("redis.call('PUBLISH'")) {
      const [sessionKey, indexKey, channel] = keys as readonly [string, string, string];
      const [sessionId, message] = args;
      const raw = this.sessions.get(sessionKey);
      if (raw === undefined) return 'MISSING';
      this.sessions.delete(sessionKey);
      this.indexes.get(indexKey)?.delete(sessionId!);
      this.published.push({ channel, message: message! });
      return raw;
    }
    if (script.includes("redis.call('GET'")) {
      const value = this.sessions.get(keys[0]!);
      return value === undefined ? [] : [value];
    }
    throw new TypeError('unexpected Redis script');
  }

  async publish(channel: string, message: string): Promise<number> {
    if (this.publishError !== null) throw this.publishError;
    this.published.push({ channel, message });
    return 1;
  }
}

class PresentationServiceFixture extends PublicPresentationSessionService {
  familyDigest = Buffer.alloc(32, 1);
  now = now;
  readonly limiterCalls: unknown[] = [];

  constructor(readonly fakeRedis: SessionRedisFake) {
    const limiter = {
      consume: async (input: unknown) => {
        this.limiterCalls.push(input);
      },
    };
    super(
      fakeRedis as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      limiter as never,
      {
        browserOrigin: 'https://sceneboard.test',
        redis: { keyPrefix: 'sceneboard:' },
      } as never,
    );
  }

  override async authorize() {
    const context: StoredPublicContext = {
      contextId,
      familyDigest: Buffer.from(this.familyDigest),
      sharePk: 1n,
      boardPk: 2n,
      revisionPk: 3n,
      publicationGeneration: 4,
      accessGeneration: 5,
      validUntil: new Date(this.now.valueOf() + 60_000).toISOString(),
      familyExpiresAt: new Date(this.now.valueOf() + 1_800_000).toISOString(),
    };
    return {
      room: context,
      actorDigest: context.familyDigest,
      pageIds: new Set([pageId]),
      now: this.now,
    };
  }
}

const statusIs =
  (status: number) =>
  (error: unknown): boolean =>
    error instanceof PublicShareHttpError && error.status === status;

test('exact tuple admits five sessions, lists them, and rejects the sixth atomically', async () => {
  const service = new PresentationServiceFixture(new SessionRedisFake());
  const sessions = [];
  for (let index = 0; index < 5; index += 1)
    sessions.push(await service.start({ contextId, currentPageId: pageId }));
  assert.equal((await service.list(contextId)).sessions.length, 5);
  assert.equal(new Set(sessions.map((session) => session.sessionId)).size, 5);
  await assert.rejects(() => service.start({ contextId, currentPageId: pageId }), statusIs(409));
});

test('only the creator family updates and ends while another family remains a viewer', async () => {
  const redis = new SessionRedisFake();
  const service = new PresentationServiceFixture(redis);
  const created = await service.start({ contextId, currentPageId: pageId });
  service.familyDigest = Buffer.alloc(32, 2);
  assert.equal((await service.get({ contextId, sessionId: created.sessionId })).role, 'viewer');
  await assert.rejects(
    () =>
      service.update({
        contextId,
        sessionId: created.sessionId,
        update: {
          expectedVersion: 0,
          currentPageId: pageId,
          annotation: { pageId, strokes: [] },
        },
      }),
    statusIs(404),
  );
  await assert.rejects(
    () => service.end({ contextId, sessionId: created.sessionId }),
    statusIs(404),
  );

  service.familyDigest = Buffer.alloc(32, 1);
  const updated = await service.update({
    contextId,
    sessionId: created.sessionId,
    update: {
      expectedVersion: 0,
      currentPageId: pageId,
      annotation: { pageId, strokes: [] },
    },
  });
  assert.equal(updated.version, 1);
  assert.equal(redis.published.length, 1);
  assert.equal(service.limiterCalls.length, 2);

  await assert.rejects(
    () =>
      service.update({
        contextId,
        sessionId: created.sessionId,
        update: {
          expectedVersion: 0,
          currentPageId: pageId,
          annotation: { pageId, strokes: [] },
        },
      }),
    statusIs(409),
  );
  assert.equal(redis.published.length, 1);
  assert.deepEqual(await service.end({ contextId, sessionId: created.sessionId }), {
    sessionId: created.sessionId,
    status: 'ended',
  });
  await assert.rejects(
    () => service.get({ contextId, sessionId: created.sessionId }),
    statusIs(404),
  );
});

test('a committed update remains readable when Redis publication fails', async () => {
  const redis = new SessionRedisFake();
  const service = new PresentationServiceFixture(redis);
  const created = await service.start({ contextId, currentPageId: pageId });
  redis.publishError = new Error('publication unavailable');

  const updated = await service.update({
    contextId,
    sessionId: created.sessionId,
    update: {
      expectedVersion: created.version,
      currentPageId: pageId,
      annotation: { pageId, strokes: [] },
    },
  });

  assert.equal(updated.version, 1);
  assert.equal(redis.published.length, 0);
  assert.equal((await service.get({ contextId, sessionId: created.sessionId })).version, 1);
});
