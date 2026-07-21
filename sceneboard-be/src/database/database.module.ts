import { Global, Module } from '@nestjs/common';

import { MigrationRunner } from './migrations/runner.js';
import { MysqlTransactionRunner } from './mysql-transaction.runner.js';
import { MysqlService } from './mysql.service.js';

@Global()
@Module({
  providers: [MysqlService, MysqlTransactionRunner, MigrationRunner],
  exports: [MysqlService, MysqlTransactionRunner, MigrationRunner],
})
export class DatabaseModule {}
