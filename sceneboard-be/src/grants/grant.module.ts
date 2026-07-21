import { Module } from '@nestjs/common';

import { AuditRepository } from '../audit/audit.repository.js';
import { AuditModule } from '../audit/audit.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { CryptoService } from '../common/security/crypto.service.js';
import { DatabaseModule } from '../database/database.module.js';
import { MysqlService } from '../database/mysql.service.js';
import { GrantController } from './grant.controller.js';
import { GrantCursorService } from './grant-cursor.service.js';
import { GrantRepository } from './grant.repository.js';
import { GrantService } from './grant.service.js';
import { GrantTokenService } from './grant-token.service.js';
import { ActorContextService } from './actor-context.service.js';
import { MysqlBoardAccessPolicy } from './board-access-policy.service.js';
import { GrantPrincipalRepository } from './grant-principal.repository.js';

@Module({
  imports: [AuthModule, DatabaseModule, AuditModule],
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
      inject: [GrantPrincipalRepository, GrantTokenService],
      useFactory: (repository: GrantPrincipalRepository, tokens: GrantTokenService) =>
        new ActorContextService(repository, tokens),
    },
    {
      provide: MysqlBoardAccessPolicy,
      inject: [MysqlService, CryptoService],
      useFactory: (mysql: MysqlService, crypto: CryptoService) =>
        new MysqlBoardAccessPolicy(mysql, crypto),
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
