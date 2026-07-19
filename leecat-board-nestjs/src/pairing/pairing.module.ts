import { Module } from '@nestjs/common';

import { AuditModule } from '../audit/audit.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { CryptoService } from '../common/security/crypto.service.js';
import { DatabaseModule } from '../database/database.module.js';
import { PairingCodeService } from './pairing-code.service.js';
import { PairingController } from './pairing.controller.js';
import { PairingRepository } from './pairing.repository.js';
import { PairingService } from './pairing.service.js';
import { APP_ENVIRONMENT, type AppEnvironment } from '../config/env.schema.js';
import { MysqlService } from '../database/mysql.service.js';
import { AuditRepository } from '../audit/audit.repository.js';
import { PairingProofService } from './pairing-proof.service.js';
import { BoardModule } from '../boards/board.module.js';
import { BoardCreateService } from '../boards/board-create.service.js';

@Module({
  imports: [AuthModule, DatabaseModule, AuditModule, BoardModule],
  controllers: [PairingController],
  providers: [
    {
      provide: PairingRepository,
      inject: [MysqlService, AuditRepository, CryptoService, BoardCreateService],
      useFactory: (
        mysql: MysqlService,
        audit: AuditRepository,
        crypto: CryptoService,
        boardCreate: BoardCreateService,
      ) => (
        new PairingRepository(mysql, audit, crypto, boardCreate)
      ),
    },
    {
      provide: PairingCodeService,
      inject: [CryptoService],
      useFactory: (crypto: CryptoService) => new PairingCodeService(crypto),
    },
    {
      provide: PairingProofService,
      inject: [CryptoService],
      useFactory: (crypto: CryptoService) => new PairingProofService(crypto),
    },
    {
      provide: PairingService,
      inject: [PairingRepository, PairingCodeService, CryptoService, APP_ENVIRONMENT],
      useFactory: (
        repository: PairingRepository,
        codes: PairingCodeService,
        crypto: CryptoService,
        environment: AppEnvironment,
      ) => new PairingService(
        repository,
        codes,
        crypto,
        environment.pairingFailureMinMs,
        environment.pairingFailureJitterMs,
      ),
    },
  ],
  exports: [PairingService, PairingProofService],
})
export class PairingModule {}
