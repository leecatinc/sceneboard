import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import {
  createPool,
  type Pool,
  type PoolConnection,
  type PoolOptions,
  type RowDataPacket,
} from 'mysql2/promise';

import { APP_ENVIRONMENT, type AppEnvironment } from '../config/env.schema.js';
import {
  buildMigrationConnectionProfile,
  type MigrationConnectionProfileV1,
} from './migrations/certification-state.js';

const REQUIRED_SQL_MODES = ['STRICT_TRANS_TABLES', 'ERROR_FOR_DIVISION_BY_ZERO', 'NO_ENGINE_SUBSTITUTION'] as const;

export const createMysqlPoolOptions = (environment: Pick<AppEnvironment, 'mysql'>): PoolOptions => ({
  host: environment.mysql.host,
  port: environment.mysql.port,
  user: environment.mysql.user,
  password: environment.mysql.password,
  database: environment.mysql.database,
  charset: 'utf8mb4',
  timezone: 'Z',
  dateStrings: true,
  supportBigNumbers: true,
  bigNumberStrings: true,
  multipleStatements: false,
  flags: ['-FOUND_ROWS'],
  connectionLimit: 10,
  maxIdle: 10,
  idleTimeout: 60_000,
  enableKeepAlive: true,
  keepAliveInitialDelay: 0,
});

interface MysqlSessionProfileRow extends RowDataPacket {
  serverVersion: string;
  versionComment: string;
  timeZone: string;
  characterSet: string;
  collation: string;
  sqlMode: string;
}

@Injectable()
export class MysqlService implements OnModuleDestroy {
  private readonly pool: Pool;

  constructor(@Inject(APP_ENVIRONMENT) private readonly environment: Pick<AppEnvironment, 'mysql'>) {
    this.pool = createPool(createMysqlPoolOptions(environment));
  }

  async withConnection<Value>(operation: (connection: PoolConnection) => Promise<Value>): Promise<Value> {
    const connection = await this.pool.getConnection();
    try {
      await this.configureConnection(connection);
      return await operation(connection);
    } finally {
      connection.release();
    }
  }

  async certifyConnection(connection: PoolConnection): Promise<MigrationConnectionProfileV1> {
    const [rows] = await connection.query<MysqlSessionProfileRow[]>(`
      SELECT
        @@version AS serverVersion,
        @@version_comment AS versionComment,
        @@session.time_zone AS timeZone,
        @@session.character_set_connection AS characterSet,
        @@session.collation_connection AS collation,
        @@session.sql_mode AS sqlMode
    `);
    const row = rows[0];
    if (!row || !/mysql community|community server/i.test(row.versionComment)) {
      throw new Error('MySQL Community Server is required');
    }
    return buildMigrationConnectionProfile({
      databaseIdentity: `${this.environment.mysql.host}:${this.environment.mysql.port}/${this.environment.mysql.database}/${this.environment.mysql.user}`,
      serverVersion: row.serverVersion,
      timeZone: row.timeZone,
      characterSet: row.characterSet,
      collation: row.collation,
      sqlMode: row.sqlMode,
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }

  private async configureConnection(connection: PoolConnection): Promise<void> {
    await connection.query("SET SESSION time_zone = '+00:00'");
    await connection.query('SET NAMES utf8mb4 COLLATE utf8mb4_0900_ai_ci');
    const [rows] = await connection.query<Array<RowDataPacket & { sqlMode: string }>>(
      'SELECT @@session.sql_mode AS sqlMode',
    );
    const modes = new Set((rows[0]?.sqlMode ?? '').split(',').filter(Boolean));
    if (modes.has('NO_BACKSLASH_ESCAPES')) throw new Error('NO_BACKSLASH_ESCAPES is forbidden');
    for (const mode of REQUIRED_SQL_MODES) {
      if (!modes.has(mode)) throw new Error(`required SQL mode is missing: ${mode}`);
    }
  }
}
