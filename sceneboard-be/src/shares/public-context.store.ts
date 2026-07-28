import { PublicContextIdParserV1 } from '@sceneboard/board-schema';

import type { AppEnvironment } from '../config/env.schema.js';
import type { RedisService } from '../redis/redis.service.js';
import {
  PUBLIC_CONTEXT_FAMILY_TTL_SECONDS,
  PublicContextCookieService,
  type PublicContextCookieInspection,
} from './public-context-cookie.service.js';
import { PublicShareHttpError } from './public-share.error.js';

const REUSE_CONTEXT_LUA = `
local family = redis.call('GET', KEYS[1])
if not family then return 0 end
local decoded = cjson.decode(family)
local familyExpiry = tonumber(decoded.expiresAt)
local now = tonumber(ARGV[1])
local contextExpiry = tonumber(ARGV[2])
if not familyExpiry or familyExpiry <= now then
  redis.call('DEL', KEYS[1])
  return 0
end
if contextExpiry <= now or contextExpiry > familyExpiry then return -1 end
if redis.call('SET', KEYS[2], ARGV[3], 'PXAT', contextExpiry, 'NX') ~= 'OK' then return -1 end
return 1`;

const CREATE_CONTEXT_LUA = `
if redis.call('EXISTS', KEYS[1], KEYS[2]) ~= 0 then return 0 end
redis.call('MSET', KEYS[1], ARGV[1], KEYS[2], ARGV[3])
redis.call('PEXPIREAT', KEYS[1], ARGV[2])
redis.call('PEXPIREAT', KEYS[2], ARGV[4])
return 1`;

const READ_CONTEXT_LUA = `
local family = redis.call('GET', KEYS[1])
local context = redis.call('GET', KEYS[2])
if not family or not context then return {} end
return {family, context}`;

export interface PublicContextTuple {
  sharePk: bigint;
  boardPk: bigint;
  revisionPk: bigint;
  publicationGeneration: number;
  accessGeneration: number;
}

export interface StoredPublicContext extends PublicContextTuple {
  contextId: string;
  familyDigest: Buffer;
  validUntil: string;
  familyExpiresAt: string;
}

interface ContextJson {
  sharePk: string;
  boardPk: string;
  revisionPk: string;
  publicationGeneration: number;
  accessGeneration: number;
  validUntil: string;
}

const unsignedPk = (value: unknown): bigint => {
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,19}$/u.test(value))
    throw new PublicShareHttpError(503);
  const parsed = BigInt(value);
  if (parsed > 18_446_744_073_709_551_615n) throw new PublicShareHttpError(503);
  return parsed;
};

const generation = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1)
    throw new PublicShareHttpError(503);
  return value;
};

const instant = (value: unknown): Date => {
  if (typeof value !== 'string') throw new PublicShareHttpError(503);
  const date = new Date(value);
  if (!Number.isFinite(date.valueOf()) || date.toISOString() !== value)
    throw new PublicShareHttpError(503);
  return date;
};

const epochInstant = (value: unknown): Date => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1)
    throw new PublicShareHttpError(503);
  const date = new Date(value);
  if (!Number.isFinite(date.valueOf())) throw new PublicShareHttpError(503);
  return date;
};

const exactRecord = (value: unknown, expectedKeys: readonly string[]): Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new PublicShareHttpError(503);
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index]))
    throw new PublicShareHttpError(503);
  return record;
};

export class PublicContextStore {
  private readonly keyPrefix: string;

  constructor(
    private readonly redis: RedisService,
    private readonly cookies: PublicContextCookieService,
    environment: AppEnvironment,
  ) {
    this.keyPrefix = environment.redis.keyPrefix;
  }

  newContextId(): string {
    const contextId = this.cookies.newContextId();
    if (!PublicContextIdParserV1.parse(contextId).ok) throw new PublicShareHttpError(503);
    return contextId;
  }

  async persist(input: {
    contextId: string;
    cookie: PublicContextCookieInspection;
    hostname: string;
    now: Date;
    validUntil: Date;
    tuple: PublicContextTuple;
  }): Promise<{ familyDigest: Buffer; setCookie: string | null; familyExpiresAt: Date }> {
    if (
      input.validUntil.valueOf() <= input.now.valueOf() ||
      input.validUntil.valueOf() - input.now.valueOf() > 60_000
    )
      throw new PublicShareHttpError(503);
    const contextJson = JSON.stringify({
      sharePk: input.tuple.sharePk.toString(),
      boardPk: input.tuple.boardPk.toString(),
      revisionPk: input.tuple.revisionPk.toString(),
      publicationGeneration: input.tuple.publicationGeneration,
      accessGeneration: input.tuple.accessGeneration,
      validUntil: input.validUntil.toISOString(),
    } satisfies ContextJson);
    try {
      if (input.cookie.kind === 'valid') {
        const reused = await this.redis.evaluate(
          REUSE_CONTEXT_LUA,
          [
            this.familyKey(input.cookie.digest),
            this.contextKey(input.cookie.digest, input.contextId),
          ],
          [String(input.now.valueOf()), String(input.validUntil.valueOf()), contextJson],
        );
        if (Number(reused) === 1) {
          const family = await this.readFamily(input.cookie.digest);
          return {
            familyDigest: input.cookie.digest,
            setCookie: null,
            familyExpiresAt: family,
          };
        }
        if (Number(reused) === -1) throw new PublicShareHttpError(503);
      }
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const issued = this.cookies.issue(input.hostname);
        const familyExpiresAt = new Date(
          input.now.valueOf() + PUBLIC_CONTEXT_FAMILY_TTL_SECONDS * 1_000,
        );
        const familyJson = JSON.stringify({ expiresAt: familyExpiresAt.valueOf() });
        const created = await this.redis.evaluate(
          CREATE_CONTEXT_LUA,
          [this.familyKey(issued.digest), this.contextKey(issued.digest, input.contextId)],
          [
            familyJson,
            String(familyExpiresAt.valueOf()),
            contextJson,
            String(input.validUntil.valueOf()),
          ],
        );
        if (Number(created) === 1)
          return {
            familyDigest: issued.digest,
            setCookie: issued.setCookie,
            familyExpiresAt,
          };
      }
    } catch (error) {
      if (error instanceof PublicShareHttpError) throw error;
      throw new PublicShareHttpError(503);
    }
    throw new PublicShareHttpError(503);
  }

  async read(input: {
    familyDigest: Buffer;
    contextId: string;
  }): Promise<StoredPublicContext | null> {
    try {
      const raw = await this.redis.evaluate(
        READ_CONTEXT_LUA,
        [this.familyKey(input.familyDigest), this.contextKey(input.familyDigest, input.contextId)],
        [],
      );
      if (!Array.isArray(raw) || raw.length === 0) return null;
      if (raw.length !== 2 || typeof raw[0] !== 'string' || typeof raw[1] !== 'string')
        throw new PublicShareHttpError(503);
      const family = exactRecord(JSON.parse(raw[0]), ['expiresAt']);
      const context = exactRecord(JSON.parse(raw[1]), [
        'accessGeneration',
        'boardPk',
        'publicationGeneration',
        'revisionPk',
        'sharePk',
        'validUntil',
      ]);
      const familyExpiresAt = epochInstant(family.expiresAt);
      const validUntil = instant(context.validUntil);
      return {
        contextId: input.contextId,
        familyDigest: Buffer.from(input.familyDigest),
        sharePk: unsignedPk(context.sharePk),
        boardPk: unsignedPk(context.boardPk),
        revisionPk: unsignedPk(context.revisionPk),
        publicationGeneration: generation(context.publicationGeneration),
        accessGeneration: generation(context.accessGeneration),
        validUntil: validUntil.toISOString(),
        familyExpiresAt: familyExpiresAt.toISOString(),
      };
    } catch (error) {
      if (error instanceof PublicShareHttpError) throw error;
      throw new PublicShareHttpError(503);
    }
  }

  private async readFamily(digest: Buffer): Promise<Date> {
    const raw = await this.redis.evaluate(
      `local value = redis.call('GET', KEYS[1]); if not value then return {} end; return {value}`,
      [this.familyKey(digest)],
      [],
    );
    if (!Array.isArray(raw) || raw.length !== 1 || typeof raw[0] !== 'string')
      throw new PublicShareHttpError(503);
    try {
      const parsed = exactRecord(JSON.parse(raw[0]), ['expiresAt']);
      return epochInstant(parsed.expiresAt);
    } catch (error) {
      if (error instanceof PublicShareHttpError) throw error;
      throw new PublicShareHttpError(503);
    }
  }

  private familyKey(digest: Buffer): string {
    return `${this.keyPrefix}public-context:v1:family:${digest.toString('hex')}`;
  }

  private contextKey(digest: Buffer, contextId: string): string {
    return `${this.keyPrefix}public-context:v1:context:${digest.toString('hex')}:${contextId}`;
  }
}
