import { Inject, Injectable } from '@nestjs/common';

import type { PersistenceTransaction, TransactionRunnerPort } from '../auth/auth.persistence.js';
import { MysqlService } from './mysql.service.js';
import { withTransaction } from './transaction.js';

@Injectable()
export class MysqlTransactionRunner implements TransactionRunnerPort {
  constructor(@Inject(MysqlService) private readonly mysql: MysqlService) {}

  async run<Value>(operation: (transaction: PersistenceTransaction) => Promise<Value>): Promise<Value> {
    return this.mysql.withConnection((connection) => withTransaction(
      connection,
      'READ COMMITTED',
      () => operation({ connection }),
    ));
  }
}
