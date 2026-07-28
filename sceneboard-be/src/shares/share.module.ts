import { Module } from '@nestjs/common';

import { AuditRepository } from '../audit/audit.repository.js';
import { CryptoService } from '../common/security/crypto.service.js';
import { DatabaseModule } from '../database/database.module.js';
import { MysqlService } from '../database/mysql.service.js';
import { GrantModule } from '../grants/grant.module.js';
import { MysqlBoardAccessPolicy } from '../grants/board-access-policy.service.js';
import { RateLimitModule } from '../rate-limit/rate-limit.module.js';
import { RateLimitService } from '../rate-limit/rate-limit.service.js';
import { RedisService } from '../redis/redis.service.js';
import { APP_ENVIRONMENT, type AppEnvironment } from '../config/env.schema.js';
import { PasswordAttemptService } from './password-attempt.service.js';
import { PasswordHashService } from './password-hash.service.js';
import { PasswordShareController } from './password-share.controller.js';
import { PasswordShareGuard } from './password-share.guard.js';
import { PasswordShareRepository } from './password-share.repository.js';
import { PasswordShareService } from './password-share.service.js';
import { PasswordSessionCleanupService } from './password-session-cleanup.service.js';
import { ShareCookieService } from './share-cookie.service.js';
import { ShareController } from './share.controller.js';
import { ShareArchiveService } from './share-archive.service.js';
import { SharePublicationService } from './share-publication.service.js';
import { ShareRepository } from './share.repository.js';
import { ShareTokenService } from './share-token.service.js';
import { ShareTransitionRecoveryService } from './share-transition-recovery.service.js';

@Module({
  imports: [DatabaseModule, GrantModule, RateLimitModule],
  controllers: [ShareController, PasswordShareController],
  providers: [
    {
      provide: ShareTokenService,
      inject: [CryptoService],
      useFactory: (crypto: CryptoService) => new ShareTokenService(crypto),
    },
    {
      provide: ShareRepository,
      inject: [CryptoService, AuditRepository],
      useFactory: (crypto: CryptoService, audit: AuditRepository) =>
        new ShareRepository(crypto, audit),
    },
    {
      provide: ShareTransitionRecoveryService,
      inject: [ShareRepository],
      useFactory: (shares: ShareRepository) => new ShareTransitionRecoveryService(shares),
    },
    {
      provide: PasswordHashService,
      inject: [CryptoService],
      useFactory: (crypto: CryptoService) => new PasswordHashService(crypto),
    },
    {
      provide: ShareCookieService,
      inject: [APP_ENVIRONMENT, CryptoService],
      useFactory: (environment: AppEnvironment, crypto: CryptoService) =>
        new ShareCookieService(environment, crypto),
    },
    {
      provide: PasswordAttemptService,
      inject: [RedisService, CryptoService, APP_ENVIRONMENT],
      useFactory: (redis: RedisService, crypto: CryptoService, environment: AppEnvironment) =>
        new PasswordAttemptService(redis, crypto, environment.redis.keyPrefix),
    },
    {
      provide: PasswordShareRepository,
      inject: [ShareRepository],
      useFactory: (shares: ShareRepository) => new PasswordShareRepository(shares),
    },
    {
      provide: PasswordShareGuard,
      inject: [
        MysqlService,
        ShareRepository,
        PasswordShareRepository,
        ShareTokenService,
        ShareCookieService,
      ],
      useFactory: (
        mysql: MysqlService,
        shares: ShareRepository,
        passwords: PasswordShareRepository,
        tokens: ShareTokenService,
        cookies: ShareCookieService,
      ) => new PasswordShareGuard(mysql, shares, passwords, tokens, cookies),
    },
    {
      provide: ShareArchiveService,
      inject: [ShareRepository, ShareTransitionRecoveryService],
      useFactory: (shares: ShareRepository, recovery: ShareTransitionRecoveryService) =>
        new ShareArchiveService(shares, recovery),
    },
    {
      provide: SharePublicationService,
      inject: [
        MysqlBoardAccessPolicy,
        ShareRepository,
        ShareTransitionRecoveryService,
        ShareTokenService,
        RateLimitService,
      ],
      useFactory: (
        accessPolicy: MysqlBoardAccessPolicy,
        shares: ShareRepository,
        recovery: ShareTransitionRecoveryService,
        tokens: ShareTokenService,
        rateLimits: RateLimitService,
      ) => new SharePublicationService(accessPolicy, shares, recovery, tokens, rateLimits),
    },
    {
      provide: PasswordShareService,
      inject: [
        MysqlBoardAccessPolicy,
        MysqlService,
        ShareRepository,
        PasswordShareRepository,
        ShareTransitionRecoveryService,
        ShareTokenService,
        PasswordHashService,
        PasswordAttemptService,
        ShareCookieService,
      ],
      useFactory: (
        accessPolicy: MysqlBoardAccessPolicy,
        mysql: MysqlService,
        shares: ShareRepository,
        passwords: PasswordShareRepository,
        recovery: ShareTransitionRecoveryService,
        tokens: ShareTokenService,
        hasher: PasswordHashService,
        attempts: PasswordAttemptService,
        cookies: ShareCookieService,
      ) =>
        new PasswordShareService(
          accessPolicy,
          mysql,
          shares,
          passwords,
          recovery,
          tokens,
          hasher,
          attempts,
          cookies,
        ),
    },
    PasswordSessionCleanupService,
  ],
  exports: [
    ShareRepository,
    ShareTransitionRecoveryService,
    SharePublicationService,
    ShareArchiveService,
    PasswordHashService,
    ShareCookieService,
    PasswordShareService,
    PasswordShareGuard,
  ],
})
export class ShareModule {}
