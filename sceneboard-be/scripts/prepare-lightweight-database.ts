import { pathToFileURL } from 'node:url';

import { createConnection } from 'mysql2/promise';

import { parsePersistenceEnvironment } from '../src/config/env.schema.js';
import { MigrationRunner } from '../src/database/migrations/runner.js';
import { MysqlService } from '../src/database/mysql.service.js';
import { RedisService } from '../src/redis/redis.service.js';

const CONFIRMATION = 'I_CONFIRM_CREATE_OR_MIGRATE_SCENEBOARD_DEVELOPMENT_SCHEMA';

export const assertLightweightDatabasePreparationAllowed = (
  environment: NodeJS.ProcessEnv,
): void => {
  if (
    environment.APP_ENV !== 'development' ||
    environment.NODE_ENV !== 'development' ||
    environment.MYSQL_DATABASE !== 'sceneboard' ||
    environment.CONFIRM_LIGHTWEIGHT_DB_PREPARE !== CONFIRMATION
  ) {
    throw new TypeError(
      'lightweight database preparation is limited to the confirmed SceneBoard development schema',
    );
  }
};

export const prepareLightweightDatabase = async (): Promise<void> => {
  assertLightweightDatabasePreparationAllowed(process.env);
  const persistence = parsePersistenceEnvironment(process.env);
  const administrator = await createConnection({
    host: persistence.mysql.host,
    port: persistence.mysql.port,
    user: persistence.mysql.user,
    password: persistence.mysql.password,
    connectTimeout: 5_000,
  });
  try {
    await administrator.query(
      'CREATE DATABASE IF NOT EXISTS `sceneboard` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci',
    );
  } finally {
    await administrator.end();
  }

  const mysql = new MysqlService(persistence);
  const redis = new RedisService(persistence);
  try {
    const migration = await new MigrationRunner(mysql).up();
    if (!(await redis.pingCommand())) throw new TypeError('Redis readiness check failed');
    process.stdout.write(
      `${JSON.stringify({
        status: 'PASS',
        mode: 'lightweight-development',
        migrationState: migration.mode,
        registryVersion: migration.registryVersion,
        mysql: 'ready',
        redis: 'ready',
      })}\n`,
    );
  } finally {
    await redis.onModuleDestroy();
    await mysql.onModuleDestroy();
  }
};

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  prepareLightweightDatabase().catch((error: unknown) => {
    const name = error instanceof Error ? error.name : 'DatabasePreparationError';
    process.stderr.write(`SceneBoard lightweight database preparation failed: ${name}\n`);
    process.exitCode = 1;
  });
}
