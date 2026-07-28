import { Module } from '@nestjs/common';

import { AuditRepository } from '../audit/audit.repository.js';
import { ArtifactsModule } from '../artifacts/artifacts.module.js';
import { ArtifactRepository } from '../artifacts/artifact.repository.js';
import { CryptoService } from '../common/security/crypto.service.js';
import { DatabaseModule } from '../database/database.module.js';
import { MysqlService } from '../database/mysql.service.js';
import { GrantModule } from '../grants/grant.module.js';
import { MysqlBoardAccessPolicy } from '../grants/board-access-policy.service.js';
import { RateLimitModule } from '../rate-limit/rate-limit.module.js';
import { RateLimitService } from '../rate-limit/rate-limit.service.js';
import { RedisService } from '../redis/redis.service.js';
import { DocumentCheckpointCodec } from '../revisions/document-checkpoint.codec.js';
import { RevisionMediaReferenceExtractor } from '../media/revision-media-reference.extractor.js';
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
import { PublicContextCookieService } from './public-context-cookie.service.js';
import { PublicContextStore } from './public-context.store.js';
import { PublicShareResolver } from './public-share.resolver.js';
import {
  DenyAllPublicMediaProjection,
  PublicMediaProjectionPort,
} from './public-media-projection.port.js';
import { PublicShareProjectionRepository } from './public-share-projection.repository.js';
import { PublicShareProjectionService } from './public-share-projection.service.js';
import { PublicResourceEntitlementService } from './public-resource-entitlement.js';
import { PublicArtifactDeliveryService } from './public-artifact-delivery.service.js';
import { PublicShareController } from './public-share.controller.js';
import { PublicArtifactController } from './public-artifact.controller.js';

@Module({
  imports: [DatabaseModule, GrantModule, RateLimitModule, ArtifactsModule],
  controllers: [
    ShareController,
    PasswordShareController,
    PublicShareController,
    PublicArtifactController,
  ],
  providers: [
    DocumentCheckpointCodec,
    RevisionMediaReferenceExtractor,
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
      provide: PublicContextCookieService,
      inject: [APP_ENVIRONMENT, CryptoService],
      useFactory: (environment: AppEnvironment, crypto: CryptoService) =>
        new PublicContextCookieService(environment, crypto),
    },
    {
      provide: PublicContextStore,
      inject: [RedisService, PublicContextCookieService, APP_ENVIRONMENT],
      useFactory: (
        redis: RedisService,
        cookies: PublicContextCookieService,
        environment: AppEnvironment,
      ) => new PublicContextStore(redis, cookies, environment),
    },
    {
      provide: PublicShareResolver,
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
      ) => new PublicShareResolver(mysql, shares, passwords, tokens, cookies),
    },
    {
      provide: PublicMediaProjectionPort,
      useClass: DenyAllPublicMediaProjection,
    },
    {
      provide: PublicShareProjectionRepository,
      inject: [
        DocumentCheckpointCodec,
        ArtifactRepository,
        RevisionMediaReferenceExtractor,
        PublicMediaProjectionPort,
      ],
      useFactory: (
        checkpoints: DocumentCheckpointCodec,
        artifacts: ArtifactRepository,
        mediaReferences: RevisionMediaReferenceExtractor,
        media: PublicMediaProjectionPort,
      ) => new PublicShareProjectionRepository(checkpoints, artifacts, mediaReferences, media),
    },
    {
      provide: PublicShareProjectionService,
      inject: [
        PublicShareResolver,
        PublicShareProjectionRepository,
        PublicContextStore,
        PublicContextCookieService,
        ShareCookieService,
        APP_ENVIRONMENT,
      ],
      useFactory: (
        resolver: PublicShareResolver,
        projections: PublicShareProjectionRepository,
        contexts: PublicContextStore,
        contextCookies: PublicContextCookieService,
        shareCookies: ShareCookieService,
        environment: AppEnvironment,
      ) =>
        new PublicShareProjectionService(
          resolver,
          projections,
          contexts,
          contextCookies,
          shareCookies,
          environment,
        ),
    },
    {
      provide: PublicResourceEntitlementService,
      inject: [
        PublicContextStore,
        PublicContextCookieService,
        ShareCookieService,
        PublicShareResolver,
        PublicShareProjectionRepository,
        APP_ENVIRONMENT,
      ],
      useFactory: (
        contexts: PublicContextStore,
        contextCookies: PublicContextCookieService,
        shareCookies: ShareCookieService,
        resolver: PublicShareResolver,
        projections: PublicShareProjectionRepository,
        environment: AppEnvironment,
      ) =>
        new PublicResourceEntitlementService(
          contexts,
          contextCookies,
          shareCookies,
          resolver,
          projections,
          environment.browserOrigin,
        ),
    },
    {
      provide: PublicArtifactDeliveryService,
      inject: [PublicResourceEntitlementService, ArtifactRepository],
      useFactory: (entitlements: PublicResourceEntitlementService, artifacts: ArtifactRepository) =>
        new PublicArtifactDeliveryService(entitlements, artifacts),
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
