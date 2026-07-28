import { Module } from '@nestjs/common';

import { AuditRepository } from '../audit/audit.repository.js';
import { AuditModule } from '../audit/audit.module.js';
import { CryptoService } from '../common/security/crypto.service.js';
import { APP_ENVIRONMENT, type AppEnvironment } from '../config/env.schema.js';
import { DatabaseModule } from '../database/database.module.js';
import { MysqlService } from '../database/mysql.service.js';
import { GrantModule } from '../grants/grant.module.js';
import { MysqlBoardAccessPolicy } from '../grants/board-access-policy.service.js';
import { RateLimitModule } from '../rate-limit/rate-limit.module.js';
import { RateLimitService } from '../rate-limit/rate-limit.service.js';
import {
  BoardInvitationController,
  InvitationAcceptanceController,
} from './invitation.controller.js';
import { GmailInvitationMailer } from './invitation-mail.port.js';
import { InvitationRepository } from './invitation.repository.js';
import { InvitationService } from './invitation.service.js';
import { InvitationTokenService } from './invitation-token.service.js';

@Module({
  imports: [DatabaseModule, AuditModule, GrantModule, RateLimitModule],
  controllers: [BoardInvitationController, InvitationAcceptanceController],
  providers: [
    {
      provide: InvitationTokenService,
      inject: [CryptoService],
      useFactory: (crypto: CryptoService) => new InvitationTokenService(crypto),
    },
    {
      provide: InvitationRepository,
      inject: [CryptoService, AuditRepository],
      useFactory: (crypto: CryptoService, audit: AuditRepository) =>
        new InvitationRepository(crypto, audit),
    },
    {
      provide: GmailInvitationMailer,
      inject: [APP_ENVIRONMENT],
      useFactory: (environment: AppEnvironment) =>
        new GmailInvitationMailer({
          ...environment.gmail,
          browserOrigin: environment.browserOrigin,
        }),
    },
    {
      provide: InvitationService,
      inject: [
        MysqlBoardAccessPolicy,
        MysqlService,
        InvitationRepository,
        InvitationTokenService,
        GmailInvitationMailer,
        RateLimitService,
      ],
      useFactory: (
        accessPolicy: MysqlBoardAccessPolicy,
        mysql: MysqlService,
        invitations: InvitationRepository,
        tokens: InvitationTokenService,
        mailer: GmailInvitationMailer,
        rateLimits: RateLimitService,
      ) => new InvitationService(accessPolicy, mysql, invitations, tokens, mailer, rateLimits),
    },
  ],
  exports: [InvitationService],
})
export class InvitationModule {}
