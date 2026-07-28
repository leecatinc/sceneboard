import { Module } from '@nestjs/common';

import { AuditRepository } from '../audit/audit.repository.js';
import { CryptoService } from '../common/security/crypto.service.js';
import { DatabaseModule } from '../database/database.module.js';
import { GrantModule } from '../grants/grant.module.js';
import { MysqlBoardAccessPolicy } from '../grants/board-access-policy.service.js';
import { RateLimitModule } from '../rate-limit/rate-limit.module.js';
import { RateLimitService } from '../rate-limit/rate-limit.service.js';
import { ShareController } from './share.controller.js';
import { ShareArchiveService } from './share-archive.service.js';
import { SharePublicationService } from './share-publication.service.js';
import { ShareRepository } from './share.repository.js';
import { ShareTokenService } from './share-token.service.js';
import { ShareTransitionRecoveryService } from './share-transition-recovery.service.js';

@Module({
  imports: [DatabaseModule, GrantModule, RateLimitModule],
  controllers: [ShareController],
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
  ],
  exports: [
    ShareRepository,
    ShareTransitionRecoveryService,
    SharePublicationService,
    ShareArchiveService,
  ],
})
export class ShareModule {}
