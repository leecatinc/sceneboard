import { Global, Module } from '@nestjs/common';

import { APP_ENVIRONMENT, parseEnvironment } from './env.schema.js';
import { CryptoService } from '../common/security/crypto.service.js';

@Global()
@Module({
  providers: [
    {
      provide: APP_ENVIRONMENT,
      useFactory: () => parseEnvironment(process.env),
    },
    {
      provide: CryptoService,
      inject: [APP_ENVIRONMENT],
      useFactory: (environment: ReturnType<typeof parseEnvironment>) =>
        new CryptoService(environment.keys),
    },
  ],
  exports: [APP_ENVIRONMENT, CryptoService],
})
export class SceneBoardConfigModule {}
