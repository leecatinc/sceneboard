import { AppError } from '../common/errors/app-error.js';
import { CryptoService } from '../common/security/crypto.service.js';
import type { SecurityPurpose } from '../config/security.constants.js';
import { encodeBase64Url } from '../config/security.constants.js';

export interface RedisRateLimitPort {
  consume(script: string, key: string, args: readonly string[]): Promise<readonly [number, number]>;
}

export interface RateLimitInput {
  surface: string;
  purpose: Extract<
    SecurityPurpose,
    | 'rate-limit-ip/v1'
    | 'rate-limit-email/v1'
    | 'rate-limit-user/v1'
    | 'rate-limit-session/v1'
    | 'rate-limit-pairing/v1'
    | 'rate-limit-grant/v1'
  >;
  identity: string;
  limit: number;
  windowMs: number;
  unavailableRetryAfterSeconds?: number | undefined;
}

export const RATE_LIMIT_LUA = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[2])
end
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[2])
  ttl = tonumber(ARGV[2])
end
return { count, ttl }
`;

const SURFACE_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;

export class RateLimitService {
  constructor(
    private readonly redis: RedisRateLimitPort,
    private readonly crypto: CryptoService,
    private readonly keyPrefix: string,
  ) {
    if (keyPrefix !== 'sceneboard:') throw new TypeError('Redis key prefix must be sceneboard:');
  }

  async consume(input: RateLimitInput): Promise<void> {
    if (!SURFACE_PATTERN.test(input.surface)) throw new TypeError('rate-limit surface is invalid');
    if (!Number.isSafeInteger(input.limit) || input.limit < 1)
      throw new TypeError('rate-limit count is invalid');
    if (!Number.isSafeInteger(input.windowMs) || input.windowMs < 1_000)
      throw new TypeError('rate-limit window is invalid');
    const fingerprint = encodeBase64Url(this.crypto.hmac(input.purpose, input.identity));
    const key = `${this.keyPrefix}rate:v1:${input.surface}:${fingerprint}`;
    let result: readonly [number, number];
    try {
      result = await this.redis.consume(RATE_LIMIT_LUA, key, [
        String(input.limit),
        String(input.windowMs),
      ]);
    } catch (error) {
      throw new AppError('SERVICE_UNAVAILABLE', {
        retryAfterSeconds: input.unavailableRetryAfterSeconds ?? null,
        cause: error,
      });
    }
    const [count, ttlMs] = result;
    if (!Number.isSafeInteger(count) || !Number.isFinite(ttlMs))
      throw new AppError('SERVICE_UNAVAILABLE');
    if (count > input.limit) {
      throw new AppError('RATE_LIMITED', {
        retryAfterSeconds: Math.max(1, Math.ceil(ttlMs / 1_000)),
      });
    }
  }
}
