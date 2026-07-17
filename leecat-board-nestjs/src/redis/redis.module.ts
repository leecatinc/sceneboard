import { Global, Module } from '@nestjs/common';

import { APP_ENVIRONMENT, type AppEnvironment } from '../config/env.schema.js';
import { RedisStreamKeyspace } from './redis-stream-keyspace.js';
import { RedisService } from './redis.service.js';

@Global()
@Module({
  providers: [
    RedisService,
    {
      provide: RedisStreamKeyspace,
      inject: [APP_ENVIRONMENT],
      useFactory: (environment: AppEnvironment) => (
        new RedisStreamKeyspace(environment.streamKeyMaterial, environment.redis.keyPrefix)
      ),
    },
  ],
  exports: [RedisService, RedisStreamKeyspace],
})
export class RedisModule {}
