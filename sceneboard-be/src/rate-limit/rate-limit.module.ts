import { Global, Module } from '@nestjs/common';

import { CryptoService } from '../common/security/crypto.service.js';
import { APP_ENVIRONMENT, type AppEnvironment } from '../config/env.schema.js';
import { SceneBoardConfigModule } from '../config/config.module.js';
import { RedisModule } from '../redis/redis.module.js';
import { RedisService } from '../redis/redis.service.js';
import { RateLimitService } from './rate-limit.service.js';

@Global()
@Module({
  imports: [RedisModule, SceneBoardConfigModule],
  providers: [
    {
      provide: RateLimitService,
      inject: [RedisService, CryptoService, APP_ENVIRONMENT],
      useFactory: (redis: RedisService, crypto: CryptoService, environment: AppEnvironment) =>
        new RateLimitService(redis, crypto, environment.redis.keyPrefix),
    },
  ],
  exports: [RateLimitService],
})
export class RateLimitModule {}
