import type { RedisService } from '../redis/redis.service.js';
import { ExportFailureV1 } from './export-errors.js';

const EXPORT_GLOBAL_ADMISSION_KEY_V1 = 'sb:export-render:v1:global';
const EXPORT_GLOBAL_LIMIT_V1 = 4;
export const EXPORT_GLOBAL_LEASE_MS_V1 = 180_000;
const SESSION_ID_V1 = /^[A-Za-z0-9_-]{22,128}$/u;
const HOLDER_SESSION_ID_V1 = /^[A-Za-z0-9_-]{1,128}$/u;
const GENERATION_V1 = /^[A-Za-z0-9_-]{22}$/u;

export type ExportGlobalAdmissionLeaseV1 = Readonly<{
  sessionId: string;
  generation: string;
}>;

export const exportGlobalAdmissionHolderIdV1 = (lease: ExportGlobalAdmissionLeaseV1): string => {
  if (!HOLDER_SESSION_ID_V1.test(lease.sessionId))
    throw new TypeError('invalid export session identifier');
  if (!GENERATION_V1.test(lease.generation))
    throw new TypeError('invalid export admission generation');
  return `${lease.sessionId}_${lease.generation}`;
};

const ACQUIRE_GLOBAL_V1 = `
local redisTime = redis.call('TIME')
local seconds = tonumber(redisTime[1])
local microseconds = tonumber(redisTime[2])
local leaseMs = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
if not seconds or not microseconds or not leaseMs or not limit or leaseMs < 1 then return -1 end
local now = (seconds * 1000) + math.floor(microseconds / 1000)
local expiresAt = now + leaseMs
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
if not redis.call('ZSCORE', KEYS[1], ARGV[3]) and redis.call('ZCARD', KEYS[1]) >= limit then
  return 0
end
redis.call('ZADD', KEYS[1], expiresAt, ARGV[3])
redis.call('PEXPIRE', KEYS[1], expiresAt - now)
return 1
`;

const RELEASE_GLOBAL_V1 = `
redis.call('ZREM', KEYS[1], ARGV[1])
if redis.call('ZCARD', KEYS[1]) == 0 then redis.call('DEL', KEYS[1]) end
return 1
`;

const RENEW_GLOBAL_V1 = `
local redisTime = redis.call('TIME')
local seconds = tonumber(redisTime[1])
local microseconds = tonumber(redisTime[2])
local leaseMs = tonumber(ARGV[1])
if not seconds or not microseconds or not leaseMs or leaseMs < 1 then return -1 end
local now = (seconds * 1000) + math.floor(microseconds / 1000)
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
if not redis.call('ZSCORE', KEYS[1], ARGV[2]) then return 0 end
local expiresAt = now + leaseMs
redis.call('ZADD', KEYS[1], 'XX', expiresAt, ARGV[2])
redis.call('PEXPIRE', KEYS[1], expiresAt - now)
return 1
`;

export class ExportGlobalAdmissionRepositoryV1 {
  constructor(private readonly redis: RedisService) {}

  async acquire(lease: ExportGlobalAdmissionLeaseV1): Promise<boolean> {
    if (!SESSION_ID_V1.test(lease.sessionId))
      throw new TypeError('invalid export session identifier');
    const holderId = exportGlobalAdmissionHolderIdV1(lease);
    try {
      const result = await this.redis.evaluate(
        ACQUIRE_GLOBAL_V1,
        [EXPORT_GLOBAL_ADMISSION_KEY_V1],
        [String(EXPORT_GLOBAL_LEASE_MS_V1), String(EXPORT_GLOBAL_LIMIT_V1), holderId],
      );
      if (Number(result) === 1) return true;
      if (Number(result) === 0) return false;
      throw new Error('invalid export global admission result');
    } catch (error) {
      if (error instanceof ExportFailureV1) throw error;
      throw new ExportFailureV1('EXPORT_RENDERER_UNAVAILABLE');
    }
  }

  async renew(lease: ExportGlobalAdmissionLeaseV1): Promise<boolean> {
    if (!SESSION_ID_V1.test(lease.sessionId))
      throw new TypeError('invalid export session identifier');
    const holderId = exportGlobalAdmissionHolderIdV1(lease);
    try {
      const result = await this.redis.evaluate(
        RENEW_GLOBAL_V1,
        [EXPORT_GLOBAL_ADMISSION_KEY_V1],
        [String(EXPORT_GLOBAL_LEASE_MS_V1), holderId],
      );
      if (Number(result) === 1) return true;
      if (Number(result) === 0) return false;
      throw new Error('invalid export global admission renewal result');
    } catch (error) {
      if (error instanceof ExportFailureV1) throw error;
      throw new ExportFailureV1('EXPORT_RENDERER_UNAVAILABLE');
    }
  }

  async release(lease: ExportGlobalAdmissionLeaseV1): Promise<void> {
    if (!SESSION_ID_V1.test(lease.sessionId))
      throw new TypeError('invalid export session identifier');
    const holderId = exportGlobalAdmissionHolderIdV1(lease);
    await this.redis.evaluate(RELEASE_GLOBAL_V1, [EXPORT_GLOBAL_ADMISSION_KEY_V1], [holderId]);
  }
}
