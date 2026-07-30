import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';

import type { RedisService } from '../redis/redis.service.js';
import {
  EXPORT_PROJECTION_MAX_BYTES_V1,
  EXPORT_RESOURCE_MAX_COUNT_V1,
  EXPORT_RESOURCE_TOTAL_MAX_BYTES_V1,
  EXPORT_TOTAL_TIMEOUT_MS_V1,
} from './export-request.schema.js';

const SESSION_TTL_SECONDS_V1 = 60;
export const EXPORT_RENDER_HEARTBEAT_MS_V1 = 20_000;
const SESSION_SCRIPT_V1 = readFileSync(
  new URL('./export-render-session-v1.lua', import.meta.url),
  'utf8',
);

const id = (value: string): string => {
  if (!/^[A-Za-z0-9_-]{22,128}$/u.test(value))
    throw new TypeError('invalid export render session identifier');
  return value;
};

const positive = (value: bigint): string => {
  if (value < 1n || value > 18_446_744_073_709_551_615n)
    throw new TypeError('invalid export render database key');
  return value.toString();
};

const integer = (value: number): number => {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new TypeError('invalid export render integer');
  return value;
};

export type ExportRenderSessionCredentialsV1 = Readonly<{
  sessionId: string;
  token: string;
}>;

export type ExportRenderSessionOpenV1 = ExportRenderSessionCredentialsV1 &
  Readonly<{
    boardPk: bigint;
    revisionPk: bigint;
    projectionSha256: string;
    apiOrigin: string;
    webOrigin: string;
    openedAtMs: number;
  }>;

export class ExportRenderSessionRepositoryV1 {
  constructor(
    private readonly redis: RedisService,
    private readonly tokenHmacKey: Buffer,
  ) {
    if (tokenHmacKey.byteLength !== 32)
      throw new TypeError('export render token HMAC key must be 32 bytes');
  }

  issueCredentials(): ExportRenderSessionCredentialsV1 {
    return Object.freeze({
      sessionId: randomBytes(16).toString('base64url'),
      token: randomBytes(16).toString('base64url'),
    });
  }

  async open(input: ExportRenderSessionOpenV1): Promise<void> {
    id(input.sessionId);
    id(input.token);
    integer(input.openedAtMs);
    if (!/^[a-f0-9]{64}$/u.test(input.projectionSha256))
      throw new TypeError('invalid export projection digest');
    const expiresAtMs = input.openedAtMs + EXPORT_TOTAL_TIMEOUT_MS_V1;
    const fields = [
      'state',
      'open',
      'tokenHmac',
      this.tokenHmac(input.token).toString('hex'),
      'boardPk',
      positive(input.boardPk),
      'revisionPk',
      positive(input.revisionPk),
      'projectionSha256',
      input.projectionSha256,
      'apiOrigin',
      new URL(input.apiOrigin).origin,
      'webOrigin',
      new URL(input.webOrigin).origin,
      'expiresAtMs',
      String(expiresAtMs),
      'claimNonce',
      '',
      'projectionRequests',
      '0',
      'projectionBytes',
      '0',
      'resourceRequests',
      '0',
      'resourceBytes',
      '0',
    ];
    const result = await this.redis.evaluate(
      `if redis.call('EXISTS', KEYS[1]) ~= 0 then return 0 end
       redis.call('HSET', KEYS[1], unpack(ARGV))
       redis.call('EXPIRE', KEYS[1], ${SESSION_TTL_SECONDS_V1})
       return 1`,
      [this.key(input.sessionId)],
      fields,
    );
    if (Number(result) !== 1) throw new Error('export render session collision');
  }

  async claim(input: { sessionId: string; token: string; nowMs: number }): Promise<string | null> {
    const digest = this.tokenHmac(input.token).toString('hex');
    if (!(await this.authorizeToken(input.sessionId, input.token))) {
      await this.execute(input.sessionId, ['reject', String(integer(input.nowMs)), digest]).catch(
        () => undefined,
      );
      return null;
    }
    const nonce = randomBytes(16).toString('base64url');
    const result = await this.execute(input.sessionId, [
      'claim',
      String(integer(input.nowMs)),
      nonce,
      digest,
    ]);
    return result[0] === 'claimed' && result[1] === nonce ? nonce : null;
  }

  async debitProjection(input: {
    sessionId: string;
    claimNonce: string;
    nowMs: number;
    bytes: number;
  }): Promise<boolean> {
    const result = await this.execute(input.sessionId, [
      'debit',
      String(integer(input.nowMs)),
      id(input.claimNonce),
      'projectionRequests',
      'projectionBytes',
      '1',
      String(EXPORT_PROJECTION_MAX_BYTES_V1),
      String(integer(input.bytes)),
    ]);
    return result[0] === 'debited';
  }

  async debitResource(input: {
    sessionId: string;
    claimNonce: string;
    nowMs: number;
    bytes: number;
  }): Promise<boolean> {
    const result = await this.execute(input.sessionId, [
      'debit',
      String(integer(input.nowMs)),
      id(input.claimNonce),
      'resourceRequests',
      'resourceBytes',
      String(EXPORT_RESOURCE_MAX_COUNT_V1),
      String(EXPORT_RESOURCE_TOTAL_MAX_BYTES_V1),
      String(integer(input.bytes)),
    ]);
    return result[0] === 'debited';
  }

  async renew(input: { sessionId: string; claimNonce: string; nowMs: number }): Promise<boolean> {
    const result = await this.execute(input.sessionId, [
      'renew',
      String(integer(input.nowMs)),
      id(input.claimNonce),
    ]);
    return result[0] === 'renewed';
  }

  async cancel(input: { sessionId: string; token: string; nowMs: number }): Promise<void> {
    const claimNonce = await this.claim(input);
    if (claimNonce === null) return;
    await this.close({
      sessionId: input.sessionId,
      claimNonce,
      nowMs: input.nowMs,
    });
  }

  async close(input: { sessionId: string; claimNonce: string; nowMs: number }): Promise<void> {
    await this.execute(input.sessionId, [
      'close',
      String(integer(input.nowMs)),
      id(input.claimNonce),
    ]);
  }

  key(sessionId: string): string {
    return `sb:export-render:v1:{${id(sessionId)}}:session`;
  }

  async authorizeToken(sessionId: string, token: string): Promise<boolean> {
    id(sessionId);
    id(token);
    const raw = await this.redis.evaluate(
      `local value = redis.call('HGET', KEYS[1], 'tokenHmac')
       if not value then return {} end
       return {value}`,
      [this.key(sessionId)],
      [],
    );
    if (!Array.isArray(raw) || raw.length !== 1 || typeof raw[0] !== 'string') return false;
    const expected = this.tokenHmac(token);
    const actual = Buffer.from(raw[0], 'hex');
    return actual.byteLength === expected.byteLength && timingSafeEqual(actual, expected);
  }

  private tokenHmac(token: string): Buffer {
    return createHmac('sha256', this.tokenHmacKey).update(token, 'ascii').digest();
  }

  private async execute(sessionId: string, args: readonly string[]): Promise<string[]> {
    const raw = await this.redis.evaluate(SESSION_SCRIPT_V1, [this.key(sessionId)], args);
    if (!Array.isArray(raw) || raw.some((value) => typeof value !== 'string'))
      throw new Error('export render session script returned invalid data');
    return raw as string[];
  }
}
