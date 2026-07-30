import type { RedisService } from '../redis/redis.service.js';
import { ExportFailureV1 } from './export-errors.js';

const EXPORT_GLOBAL_ADMISSION_KEY_V1 = 'sb:export-render:v1:global';
const EXPORT_GLOBAL_LIMIT_V1 = 4;
const EXPORT_GLOBAL_LEASE_MS_V1 = 180_000;
const SESSION_ID_V1 = /^[A-Za-z0-9_-]{22,128}$/u;

const ACQUIRE_GLOBAL_V1 = `
local now = tonumber(ARGV[1])
local expiresAt = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
if not now or not expiresAt or not limit or expiresAt <= now then return -1 end
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
if redis.call('ZCARD', KEYS[1]) >= limit then return 0 end
redis.call('ZADD', KEYS[1], expiresAt, ARGV[4])
redis.call('PEXPIRE', KEYS[1], expiresAt - now)
return 1
`;

const RELEASE_GLOBAL_V1 = `
redis.call('ZREM', KEYS[1], ARGV[1])
if redis.call('ZCARD', KEYS[1]) == 0 then redis.call('DEL', KEYS[1]) end
return 1
`;

export class ExportGlobalAdmissionRepositoryV1 {
  constructor(private readonly redis: RedisService) {}

  async acquire(sessionId: string, nowMs: number): Promise<boolean> {
    if (!SESSION_ID_V1.test(sessionId) || !Number.isSafeInteger(nowMs) || nowMs < 1)
      throw new TypeError('invalid export global admission input');
    try {
      const result = await this.redis.evaluate(
        ACQUIRE_GLOBAL_V1,
        [EXPORT_GLOBAL_ADMISSION_KEY_V1],
        [
          String(nowMs),
          String(nowMs + EXPORT_GLOBAL_LEASE_MS_V1),
          String(EXPORT_GLOBAL_LIMIT_V1),
          sessionId,
        ],
      );
      if (Number(result) === 1) return true;
      if (Number(result) === 0) return false;
      throw new Error('invalid export global admission result');
    } catch (error) {
      if (error instanceof ExportFailureV1) throw error;
      throw new ExportFailureV1('EXPORT_RENDERER_UNAVAILABLE');
    }
  }

  async release(sessionId: string): Promise<void> {
    if (!SESSION_ID_V1.test(sessionId)) throw new TypeError('invalid export session identifier');
    await this.redis.evaluate(RELEASE_GLOBAL_V1, [EXPORT_GLOBAL_ADMISSION_KEY_V1], [sessionId]);
  }
}
