import { encodeBase64Url } from '../config/security.constants.js';
import { CryptoService } from '../common/security/crypto.service.js';
import { ShareContractError } from '../common/errors/app-error.js';
import type { RedisService } from '../redis/redis.service.js';

export const SHARE_PASSWORD_ATTEMPT_LUA = `
local clock = redis.call('TIME')
local now = tonumber(clock[1])
local cutoff = now - 900
for i = 1, 3, 2 do
  redis.call('ZREMRANGEBYSCORE', KEYS[i], '-inf', cutoff)
end
local linkLock = tonumber(redis.call('GET', KEYS[2]) or '0')
local ipLock = tonumber(redis.call('GET', KEYS[4]) or '0')
if linkLock <= now then linkLock = 0 redis.call('DEL', KEYS[2]) end
if ipLock <= now then ipLock = 0 redis.call('DEL', KEYS[4]) end
if ARGV[1] == 'clear-link' then
  redis.call('DEL', KEYS[1], KEYS[2])
  return {0, 0}
end
local active = math.max(linkLock, ipLock)
if active > now then
  return {1, active - now}
end
if ARGV[1] == 'check' then
  return {0, 0}
end
local nonce = ARGV[2]
redis.call('ZADD', KEYS[1], now, nonce .. ':l')
redis.call('ZADD', KEYS[3], now, nonce .. ':i')
redis.call('EXPIRE', KEYS[1], 1800)
redis.call('EXPIRE', KEYS[3], 1800)
local linkCount = redis.call('ZCARD', KEYS[1])
local ipCount = redis.call('ZCARD', KEYS[3])
if linkCount >= 5 then
  linkLock = now + 900
  redis.call('SET', KEYS[2], linkLock, 'EX', 1800)
end
if ipCount >= 10 then
  ipLock = now + 900
  redis.call('SET', KEYS[4], ipLock, 'EX', 1800)
end
active = math.max(linkLock, ipLock)
if active > now then
  return {1, active - now}
end
return {0, 0}
`;

type AttemptOperation = 'check' | 'failure' | 'clear-link';

export class PasswordAttemptService {
  constructor(
    private readonly redis: Pick<RedisService, 'evaluate'>,
    private readonly crypto: CryptoService,
    private readonly keyPrefix: string,
  ) {
    if (keyPrefix !== 'sceneboard:') throw new TypeError('Redis key prefix must be sceneboard:');
  }

  async assertUnlocked(tokenDigest: Buffer, ip: string): Promise<void> {
    await this.run('check', tokenDigest, ip);
  }

  async recordFailure(tokenDigest: Buffer, ip: string): Promise<void> {
    await this.run('failure', tokenDigest, ip);
  }

  async clearLink(tokenDigest: Buffer, ip: string): Promise<void> {
    await this.run('clear-link', tokenDigest, ip);
  }

  private async run(operation: AttemptOperation, tokenDigest: Buffer, ip: string): Promise<void> {
    const linkIdentity = encodeBase64Url(
      this.crypto.hmac('share-password-attempt-link/v1', tokenDigest),
    );
    const ipIdentity = encodeBase64Url(this.crypto.hmac('share-password-attempt-ip/v1', ip));
    const link = `${this.keyPrefix}share-password:v1:1:link:${linkIdentity}`;
    const ipKey = `${this.keyPrefix}share-password:v1:1:ip:${ipIdentity}`;
    let result: unknown;
    try {
      result = await this.redis.evaluate(
        SHARE_PASSWORD_ATTEMPT_LUA,
        [`${link}:events`, `${link}:lock`, `${ipKey}:events`, `${ipKey}:lock`],
        [operation, this.crypto.randomBase64Url(12)],
      );
    } catch (cause) {
      throw new ShareContractError('SERVICE_UNAVAILABLE', 1, undefined, cause);
    }
    if (
      !Array.isArray(result) ||
      result.length !== 2 ||
      !Number.isSafeInteger(Number(result[0])) ||
      !Number.isFinite(Number(result[1]))
    ) {
      throw new ShareContractError('SERVICE_UNAVAILABLE', 1);
    }
    if (Number(result[0]) === 1) {
      throw new ShareContractError(
        'SHARE_PASSWORD_LOCKED',
        Math.min(900, Math.max(1, Math.ceil(Number(result[1])))),
      );
    }
  }
}
