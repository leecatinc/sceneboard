import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import {
  PublicContextIdParserV1,
  PublicPresentationSessionIdParserV1,
  PublicPresentationSessionListParserV1,
  PublicPresentationSnapshotParserV1,
  PublicPresentationUpdateRequestParserV1,
  type PublicPresentationAnnotationV1,
  type PublicPresentationSessionListV1,
  type PublicPresentationSnapshotV1,
  type PublicPresentationUpdateRequestV1,
} from '@sceneboard/board-schema';

import type { AppEnvironment } from '../config/env.schema.js';
import type { RateLimitService } from '../rate-limit/rate-limit.service.js';
import type { RedisService } from '../redis/redis.service.js';
import type { PublicContextCookieService } from './public-context-cookie.service.js';
import type {
  PublicContextStore,
  PublicContextTuple,
  StoredPublicContext,
} from './public-context.store.js';
import { PublicShareHttpError } from './public-share.error.js';
import type { PublicShareProjectionRepository } from './public-share-projection.repository.js';
import type { PublicShareResolver } from './public-share.resolver.js';
import type { ShareCookieService } from './share-cookie.service.js';

const IDLE_TTL_MS = 2 * 60 * 60 * 1_000;
const HARD_TTL_MS = 8 * 60 * 60 * 1_000;
const MAX_ACTIVE_SESSIONS = 5;

const START_LUA = `
local expired = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
for _, id in ipairs(expired) do
  redis.call('DEL', ARGV[2] .. id)
  redis.call('ZREM', KEYS[1], id)
end
if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[3]) then return 'CAP' end
if not redis.call('SET', KEYS[2], ARGV[4], 'PXAT', ARGV[5], 'NX') then return 'COLLISION' end
redis.call('ZADD', KEYS[1], ARGV[5], ARGV[6])
redis.call('PEXPIREAT', KEYS[1], ARGV[7])
return ARGV[4]`;

const LIST_LUA = `
local expired = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
for _, id in ipairs(expired) do
  redis.call('DEL', ARGV[2] .. id)
  redis.call('ZREM', KEYS[1], id)
end
local ids = redis.call('ZRANGE', KEYS[1], 0, -1)
local values = {}
for _, id in ipairs(ids) do
  local value = redis.call('GET', ARGV[2] .. id)
  if value then table.insert(values, value) else redis.call('ZREM', KEYS[1], id) end
end
return values`;

const UPDATE_LUA = `
local raw = redis.call('GET', KEYS[1])
if not raw then return 'MISSING' end
local current = cjson.decode(raw)
if tonumber(current.version) ~= tonumber(ARGV[1]) then return 'CONFLICT' end
redis.call('SET', KEYS[1], ARGV[2], 'PXAT', ARGV[3])
redis.call('ZADD', KEYS[2], ARGV[3], ARGV[4])
return ARGV[2]`;

const END_LUA = `
local raw = redis.call('GET', KEYS[1])
if not raw then return 'MISSING' end
redis.call('DEL', KEYS[1])
redis.call('ZREM', KEYS[2], ARGV[1])
redis.call('PUBLISH', KEYS[3], ARGV[2])
return raw`;

type StoredSessionV1 = Readonly<{
  sessionId: string;
  presenterDigestHex: string;
  version: number;
  currentPageId: string;
  annotation: PublicPresentationAnnotationV1;
  startedAtMs: number;
  updatedAtMs: number;
  hardExpiresAtMs: number;
  expiresAtMs: number;
}>;

export type PublicPresentationAuthorizationV1 = Readonly<{
  room: PublicContextTuple;
  actorDigest: Buffer;
  pageIds: ReadonlySet<string>;
  now: Date;
}>;

const parseStored = (raw: unknown): StoredSessionV1 => {
  if (typeof raw !== 'string') throw new PublicShareHttpError(503);
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    throw new PublicShareHttpError(503);
  }
  if (decoded === null || typeof decoded !== 'object' || Array.isArray(decoded))
    throw new PublicShareHttpError(503);
  const value = decoded as Record<string, unknown>;
  const annotation = value.annotation;
  const snapshot = PublicPresentationSnapshotParserV1.parse({
    sessionId: value.sessionId,
    role: 'viewer',
    status: 'active',
    version: value.version,
    currentPageId: value.currentPageId,
    annotation,
    startedAt:
      typeof value.startedAtMs === 'number' ? new Date(value.startedAtMs).toISOString() : null,
    updatedAt:
      typeof value.updatedAtMs === 'number' ? new Date(value.updatedAtMs).toISOString() : null,
    expiresAt:
      typeof value.expiresAtMs === 'number' ? new Date(value.expiresAtMs).toISOString() : null,
  });
  if (
    !snapshot.ok ||
    typeof value.presenterDigestHex !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(value.presenterDigestHex) ||
    typeof value.hardExpiresAtMs !== 'number' ||
    !Number.isSafeInteger(value.hardExpiresAtMs)
  )
    throw new PublicShareHttpError(503);
  return {
    sessionId: snapshot.data.value.sessionId,
    presenterDigestHex: value.presenterDigestHex,
    version: snapshot.data.value.version,
    currentPageId: snapshot.data.value.currentPageId,
    annotation: snapshot.data.value.annotation,
    startedAtMs: Date.parse(snapshot.data.value.startedAt),
    updatedAtMs: Date.parse(snapshot.data.value.updatedAt),
    hardExpiresAtMs: value.hardExpiresAtMs,
    expiresAtMs: Date.parse(snapshot.data.value.expiresAt),
  };
};

const isPresenter = (stored: StoredSessionV1, digest: Buffer): boolean => {
  const expected = Buffer.from(stored.presenterDigestHex, 'hex');
  return (
    expected.byteLength === 32 && digest.byteLength === 32 && timingSafeEqual(expected, digest)
  );
};

const snapshot = (stored: StoredSessionV1, digest: Buffer): PublicPresentationSnapshotV1 => {
  const parsed = PublicPresentationSnapshotParserV1.parse({
    sessionId: stored.sessionId,
    role: isPresenter(stored, digest) ? 'presenter' : 'viewer',
    status: 'active',
    version: stored.version,
    currentPageId: stored.currentPageId,
    annotation: stored.annotation,
    startedAt: new Date(stored.startedAtMs).toISOString(),
    updatedAt: new Date(stored.updatedAtMs).toISOString(),
    expiresAt: new Date(stored.expiresAtMs).toISOString(),
  });
  if (!parsed.ok) throw new PublicShareHttpError(503);
  return parsed.data.value;
};

export class PublicPresentationSessionService {
  private readonly hostname: string;
  private readonly keyPrefix: string;

  constructor(
    private readonly redis: RedisService,
    private readonly contexts: PublicContextStore,
    private readonly contextCookies: PublicContextCookieService,
    private readonly shareCookies: ShareCookieService,
    private readonly resolver: PublicShareResolver,
    private readonly projections: PublicShareProjectionRepository,
    private readonly rateLimits: RateLimitService,
    environment: AppEnvironment,
  ) {
    this.hostname = new URL(environment.browserOrigin).hostname;
    this.keyPrefix = environment.redis.keyPrefix;
  }

  async authorize(
    contextIdInput: string,
    cookieHeader?: string,
  ): Promise<PublicPresentationAuthorizationV1> {
    const contextId = PublicContextIdParserV1.parse(contextIdInput);
    if (!contextId.ok) throw new PublicShareHttpError(400);
    const family = this.contextCookies.inspect(cookieHeader, this.hostname);
    if (family.kind === 'invalid') throw new PublicShareHttpError(400);
    if (family.kind === 'absent') throw new PublicShareHttpError(404);
    const stored = await this.contexts.read({
      familyDigest: family.digest,
      contextId: contextId.data.value,
    });
    if (stored === null) throw new PublicShareHttpError(404);
    const shareFamily = this.shareCookies.inspectFamilyHeader(cookieHeader, this.hostname);
    return this.resolver.withContext({
      context: stored,
      shareFamily,
      operation: async (resolved) => {
        const projection = await this.projections.build(resolved, contextId.data.value);
        return {
          room: stored,
          actorDigest: stored.familyDigest,
          pageIds: new Set(projection.document.pages.map((page) => page.pageId)),
          now: resolved.now,
        };
      },
    });
  }

  async list(contextId: string, cookieHeader?: string): Promise<PublicPresentationSessionListV1> {
    const authorized = await this.authorize(contextId, cookieHeader);
    return this.listAuthorized(authorized);
  }

  async listAuthorized(
    authorized: PublicPresentationAuthorizationV1,
  ): Promise<PublicPresentationSessionListV1> {
    const tuple = this.tuple(authorized.room);
    const raw = await this.safeEvaluate(
      LIST_LUA,
      [this.indexKey(tuple)],
      [String(authorized.now.valueOf()), this.sessionPrefix(tuple)],
    );
    if (!Array.isArray(raw)) throw new PublicShareHttpError(503);
    const sessions = raw
      .map(parseStored)
      .filter((session) => session.expiresAtMs > authorized.now.valueOf())
      .map((session) => ({
        sessionId: session.sessionId,
        role: isPresenter(session, authorized.actorDigest) ? 'presenter' : 'viewer',
        startedAt: new Date(session.startedAtMs).toISOString(),
        updatedAt: new Date(session.updatedAtMs).toISOString(),
        expiresAt: new Date(session.expiresAtMs).toISOString(),
      }))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    const parsed = PublicPresentationSessionListParserV1.parse({ sessions });
    if (!parsed.ok) throw new PublicShareHttpError(503);
    return parsed.data.value;
  }

  async start(input: {
    contextId: string;
    cookieHeader?: string;
    currentPageId: string;
  }): Promise<PublicPresentationSnapshotV1> {
    const authorized = await this.authorize(input.contextId, input.cookieHeader);
    return this.startAuthorized(authorized, input.currentPageId);
  }

  async startAuthorized(
    authorized: PublicPresentationAuthorizationV1,
    currentPageId: string,
  ): Promise<PublicPresentationSnapshotV1> {
    if (!authorized.pageIds.has(currentPageId)) throw new PublicShareHttpError(400);
    const tuple = this.tuple(authorized.room);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const sessionId = randomBytes(32).toString('base64url');
      const nowMs = authorized.now.valueOf();
      const hardExpiresAtMs = nowMs + HARD_TTL_MS;
      const expiresAtMs = Math.min(nowMs + IDLE_TTL_MS, hardExpiresAtMs);
      const stored: StoredSessionV1 = {
        sessionId,
        presenterDigestHex: authorized.actorDigest.toString('hex'),
        version: 0,
        currentPageId,
        annotation: { pageId: currentPageId as never, strokes: [] },
        startedAtMs: nowMs,
        updatedAtMs: nowMs,
        hardExpiresAtMs,
        expiresAtMs,
      };
      const raw = await this.safeEvaluate(
        START_LUA,
        [this.indexKey(tuple), this.sessionKey(tuple, sessionId)],
        [
          String(nowMs),
          this.sessionPrefix(tuple),
          String(MAX_ACTIVE_SESSIONS),
          JSON.stringify(stored),
          String(expiresAtMs),
          sessionId,
          String(hardExpiresAtMs),
        ],
      );
      if (raw === 'CAP') throw new PublicShareHttpError(409);
      if (raw === 'COLLISION') continue;
      return snapshot(parseStored(raw), authorized.actorDigest);
    }
    throw new PublicShareHttpError(503);
  }

  async get(input: {
    contextId: string;
    sessionId: string;
    cookieHeader?: string;
  }): Promise<PublicPresentationSnapshotV1> {
    const authorized = await this.authorize(input.contextId, input.cookieHeader);
    return this.getAuthorized(authorized, input.sessionId);
  }

  async getAuthorized(
    authorized: PublicPresentationAuthorizationV1,
    sessionIdInput: string,
  ): Promise<PublicPresentationSnapshotV1> {
    const sessionId = this.parseSessionId(sessionIdInput);
    const tuple = this.tuple(authorized.room);
    const raw = await this.safeEvaluate(
      `local value = redis.call('GET', KEYS[1]); if not value then return {} end; return {value}`,
      [this.sessionKey(tuple, sessionId)],
      [],
    );
    if (!Array.isArray(raw) || raw.length === 0) throw new PublicShareHttpError(404);
    const stored = parseStored(raw[0]);
    if (stored.expiresAtMs <= authorized.now.valueOf()) throw new PublicShareHttpError(404);
    return snapshot(stored, authorized.actorDigest);
  }

  async update(input: {
    contextId: string;
    sessionId: string;
    cookieHeader?: string;
    update: PublicPresentationUpdateRequestV1;
  }): Promise<PublicPresentationSnapshotV1> {
    const authorized = await this.authorize(input.contextId, input.cookieHeader);
    return this.updateAuthorized(authorized, input.sessionId, input.update);
  }

  async updateAuthorized(
    authorized: PublicPresentationAuthorizationV1,
    sessionIdInput: string,
    update: PublicPresentationUpdateRequestV1,
  ): Promise<PublicPresentationSnapshotV1> {
    const sessionId = this.parseSessionId(sessionIdInput);
    await this.rateLimits.consume({
      surface: 'public-presentation-update-family',
      purpose: 'rate-limit-session/v1',
      identity: `${authorized.actorDigest.toString('hex')}\u0000${sessionId}`,
      limit: 3_000,
      windowMs: 5 * 60 * 1_000,
    });
    if (!authorized.pageIds.has(update.currentPageId)) throw new PublicShareHttpError(400);
    const parsedUpdate = PublicPresentationUpdateRequestParserV1.parse(update);
    if (!parsedUpdate.ok) throw new PublicShareHttpError(400);
    const tuple = this.tuple(authorized.room);
    const current = await this.getAuthorized(authorized, sessionId);
    const rawCurrent = await this.readStored(tuple, sessionId);
    if (!isPresenter(rawCurrent, authorized.actorDigest)) throw new PublicShareHttpError(404);
    if (current.version !== update.expectedVersion) throw new PublicShareHttpError(409);
    const nowMs = authorized.now.valueOf();
    const expiresAtMs = Math.min(nowMs + IDLE_TTL_MS, rawCurrent.hardExpiresAtMs);
    if (expiresAtMs <= nowMs) throw new PublicShareHttpError(404);
    const next: StoredSessionV1 = {
      ...rawCurrent,
      version: rawCurrent.version + 1,
      currentPageId: parsedUpdate.data.value.currentPageId,
      annotation: parsedUpdate.data.value.annotation,
      updatedAtMs: nowMs,
      expiresAtMs,
    };
    const committed = await this.safeEvaluate(
      UPDATE_LUA,
      [this.sessionKey(tuple, sessionId), this.indexKey(tuple)],
      [String(update.expectedVersion), JSON.stringify(next), String(expiresAtMs), sessionId],
    );
    if (committed === 'MISSING') throw new PublicShareHttpError(404);
    if (committed === 'CONFLICT') throw new PublicShareHttpError(409);
    const stored = parseStored(committed);
    try {
      await this.redis.publish(this.channel(tuple, sessionId), JSON.stringify(stored));
    } catch {
      // 스냅샷은 이미 커밋되었으므로 재연결한 스트림이 Redis에서 최신 상태를 복구한다.
    }
    return snapshot(stored, authorized.actorDigest);
  }

  async end(input: {
    contextId: string;
    sessionId: string;
    cookieHeader?: string;
  }): Promise<{ sessionId: string; status: 'ended' }> {
    const authorized = await this.authorize(input.contextId, input.cookieHeader);
    return this.endAuthorized(authorized, input.sessionId);
  }

  async endAuthorized(
    authorized: PublicPresentationAuthorizationV1,
    sessionIdInput: string,
  ): Promise<{ sessionId: string; status: 'ended' }> {
    const sessionId = this.parseSessionId(sessionIdInput);
    const tuple = this.tuple(authorized.room);
    const stored = await this.readStored(tuple, sessionId);
    if (!isPresenter(stored, authorized.actorDigest)) throw new PublicShareHttpError(404);
    const result = await this.safeEvaluate(
      END_LUA,
      [this.sessionKey(tuple, sessionId), this.indexKey(tuple), this.channel(tuple, sessionId)],
      [sessionId, JSON.stringify({ type: 'presentation.ended.v1', sessionId })],
    );
    if (result === 'MISSING') throw new PublicShareHttpError(404);
    return { sessionId, status: 'ended' };
  }

  channelFor(context: StoredPublicContext, sessionId: string): string {
    return this.channel(this.tuple(context), this.parseSessionId(sessionId));
  }

  channelForRoom(room: PublicContextTuple, sessionId: string): string {
    return this.channel(this.tuple(room), this.parseSessionId(sessionId));
  }

  private async readStored(tuple: string, sessionId: string): Promise<StoredSessionV1> {
    const raw = await this.safeEvaluate(
      `local value = redis.call('GET', KEYS[1]); if not value then return {} end; return {value}`,
      [this.sessionKey(tuple, sessionId)],
      [],
    );
    if (!Array.isArray(raw) || raw.length === 0) throw new PublicShareHttpError(404);
    return parseStored(raw[0]);
  }

  private parseSessionId(value: string): string {
    const parsed = PublicPresentationSessionIdParserV1.parse(value);
    if (!parsed.ok) throw new PublicShareHttpError(400);
    return parsed.data.value;
  }

  private tuple(context: PublicContextTuple): string {
    return createHash('sha256')
      .update(
        [
          context.sharePk,
          context.boardPk,
          context.revisionPk,
          context.publicationGeneration,
          context.accessGeneration,
        ].join('\u0000'),
      )
      .digest('hex');
  }

  private indexKey(tuple: string): string {
    return `${this.keyPrefix}public-presentation:v1:index:${tuple}`;
  }
  private sessionPrefix(tuple: string): string {
    return `${this.keyPrefix}public-presentation:v1:session:${tuple}:`;
  }
  private sessionKey(tuple: string, sessionId: string): string {
    return `${this.sessionPrefix(tuple)}${sessionId}`;
  }
  private channel(tuple: string, sessionId: string): string {
    return `${this.keyPrefix}public-presentation:v1:channel:${tuple}:${sessionId}`;
  }

  private async safeEvaluate(
    script: string,
    keys: readonly string[],
    args: readonly string[],
  ): Promise<unknown> {
    try {
      return await this.redis.evaluate(script, keys, args);
    } catch (error) {
      if (error instanceof PublicShareHttpError) throw error;
      throw new PublicShareHttpError(503);
    }
  }
}
