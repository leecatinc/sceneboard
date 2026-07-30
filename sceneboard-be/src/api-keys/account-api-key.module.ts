import { Module } from '@nestjs/common';

import { AuditModule } from '../audit/audit.module.js';
import { AuditRepository } from '../audit/audit.repository.js';
import { CryptoService } from '../common/security/crypto.service.js';
import { APP_ENVIRONMENT, type AppEnvironment } from '../config/env.schema.js';
import { DatabaseModule } from '../database/database.module.js';
import { MysqlService } from '../database/mysql.service.js';
import { RateLimitModule } from '../rate-limit/rate-limit.module.js';
import { RateLimitService } from '../rate-limit/rate-limit.service.js';
import { AccountApiKeyRepository } from './account-api-key.repository.js';
import { AccountApiKeyService } from './account-api-key.service.js';
import { AccountApiKeyTokenCodec } from './account-api-key-token.codec.js';
import { AccountApiKeyController } from './account-api-key.controller.js';
import { AccountApiKeyListCursorCodec } from './account-api-key-list-cursor.codec.js';

@Module({
  imports: [AuditModule, DatabaseModule, RateLimitModule],
  controllers: [AccountApiKeyController],
  providers: [
    {
      provide: AccountApiKeyListCursorCodec,
      inject: [APP_ENVIRONMENT],
      useFactory: (environment: AppEnvironment) =>
        new AccountApiKeyListCursorCodec(environment.cursorMacKey),
    },
    {
      provide: AccountApiKeyTokenCodec,
      inject: [CryptoService],
      useFactory: (crypto: CryptoService) => new AccountApiKeyTokenCodec(crypto),
    },
    {
      provide: AccountApiKeyRepository,
      inject: [MysqlService, AuditRepository],
      useFactory: (mysql: MysqlService, audit: AuditRepository) =>
        new AccountApiKeyRepository(mysql, audit),
    },
    {
      provide: AccountApiKeyService,
      inject: [
        AccountApiKeyRepository,
        AccountApiKeyTokenCodec,
        CryptoService,
        RateLimitService,
        APP_ENVIRONMENT,
      ],
      useFactory: (
        repository: AccountApiKeyRepository,
        tokens: AccountApiKeyTokenCodec,
        crypto: CryptoService,
        limiter: RateLimitService,
        environment: AppEnvironment,
      ) => new AccountApiKeyService(repository, tokens, crypto, limiter, environment),
    },
  ],
  exports: [AccountApiKeyService],
})
export class AccountApiKeyModule {}
