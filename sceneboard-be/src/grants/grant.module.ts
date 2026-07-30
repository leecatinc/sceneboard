import { Module } from '@nestjs/common';

import { AccountApiKeyModule } from '../api-keys/account-api-key.module.js';
import { AccountApiKeyService } from '../api-keys/account-api-key.service.js';
import { AuditRepository } from '../audit/audit.repository.js';
import { AuditModule } from '../audit/audit.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { CryptoService } from '../common/security/crypto.service.js';
import { DatabaseModule } from '../database/database.module.js';
import { MysqlService } from '../database/mysql.service.js';
import { BoardMembershipAuthorizationService } from '../memberships/membership.service.js';
import { MembershipsModule } from '../memberships/memberships.module.js';
import { GrantController } from './grant.controller.js';
import { GrantCursorService } from './grant-cursor.service.js';
import { GrantRepository } from './grant.repository.js';
import { GrantService } from './grant.service.js';
import { GrantTokenService } from './grant-token.service.js';
import { ActorContextService } from './actor-context.service.js';
import { MysqlBoardAccessPolicy } from './board-access-policy.service.js';
import { GrantPrincipalRepository } from './grant-principal.repository.js';

@Module({
  imports: [AccountApiKeyModule, AuthModule, DatabaseModule, AuditModule, MembershipsModule],
  controllers: [GrantController],
  providers: [
    {
      provide: GrantRepository,
      inject: [MysqlService, AuditRepository, CryptoService],
      useFactory: (mysql: MysqlService, audit: AuditRepository, crypto: CryptoService) =>
        new GrantRepository(mysql, audit, crypto),
    },
    {
      provide: GrantCursorService,
      inject: [CryptoService],
      useFactory: (crypto: CryptoService) => new GrantCursorService(crypto),
    },
    {
      provide: GrantTokenService,
      inject: [CryptoService],
      useFactory: (crypto: CryptoService) => new GrantTokenService(crypto),
    },
    {
      provide: GrantPrincipalRepository,
      inject: [MysqlService, AuditRepository, CryptoService],
      useFactory: (mysql: MysqlService, audit: AuditRepository, crypto: CryptoService) =>
        new GrantPrincipalRepository(mysql, audit, crypto),
    },
    {
      provide: ActorContextService,
      inject: [GrantPrincipalRepository, GrantTokenService, AccountApiKeyService],
      useFactory: (
        repository: GrantPrincipalRepository,
        tokens: GrantTokenService,
        accountApiKeys: AccountApiKeyService,
      ) => new ActorContextService(repository, tokens, accountApiKeys),
    },
    {
      provide: MysqlBoardAccessPolicy,
      inject: [
        MysqlService,
        CryptoService,
        BoardMembershipAuthorizationService,
        AccountApiKeyService,
      ],
      useFactory: (
        mysql: MysqlService,
        crypto: CryptoService,
        memberships: BoardMembershipAuthorizationService,
        accountApiKeys: AccountApiKeyService,
      ) => new MysqlBoardAccessPolicy(mysql, crypto, {}, memberships, accountApiKeys),
    },
    {
      provide: GrantService,
      inject: [GrantRepository, GrantCursorService, GrantTokenService],
      useFactory: (
        repository: GrantRepository,
        cursors: GrantCursorService,
        tokens: GrantTokenService,
      ) => new GrantService(repository, cursors, tokens),
    },
  ],
  exports: [GrantService, ActorContextService, MysqlBoardAccessPolicy],
})
export class GrantModule {}
