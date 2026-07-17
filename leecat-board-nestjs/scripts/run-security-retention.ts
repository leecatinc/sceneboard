import { AuditRepository } from '../src/audit/audit.repository.js';
import { parseEnvironment } from '../src/config/env.schema.js';
import { MysqlService } from '../src/database/mysql.service.js';
import {
  SecurityRetentionService,
  type SecurityRetentionMode,
} from '../src/maintenance/security-retention.service.js';

const args = process.argv.slice(2);
if (args.length !== 1 || !['status', 'dry-run', 'run'].includes(args[0] ?? '')) {
  throw new TypeError('usage: run-security-retention.ts <status|dry-run|run>');
}

const mysql = new MysqlService(parseEnvironment(process.env));
try {
  const report = await new SecurityRetentionService(mysql, new AuditRepository()).execute(args[0] as SecurityRetentionMode);
  process.stdout.write(`${JSON.stringify(report)}\n`);
} finally {
  await mysql.onModuleDestroy();
}
