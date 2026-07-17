import { Global, Module } from '@nestjs/common';

import { MysqlService } from '../database/mysql.service.js';
import { createMysqlPersistenceCertificationProbes } from './mysql-persistence-certification.probes.js';
import { PersistenceCertificationService } from './persistence-certification.service.js';

@Global()
@Module({
  providers: [{
    provide: PersistenceCertificationService,
    inject: [MysqlService],
    useFactory: (mysql: MysqlService) => new PersistenceCertificationService(
      createMysqlPersistenceCertificationProbes(mysql),
    ),
  }],
  exports: [PersistenceCertificationService],
})
export class PersistenceCertificationModule {}
