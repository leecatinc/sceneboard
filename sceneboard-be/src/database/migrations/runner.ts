import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { Inject, Injectable } from '@nestjs/common';
import type { PoolConnection, RowDataPacket } from 'mysql2/promise';

import { MysqlService } from '../mysql.service.js';
import { isMysqlLockAcquired } from '../../common/database/mysql-lock.js';
import type { MigrationCertificationStateV1 } from './certification-state.js';
import {
  MIGRATION_REGISTRY,
  MIGRATION_REGISTRY_VERSION,
  type MigrationRegistryEntry,
} from './registry.js';
import { splitSqlStatements } from './sql-splitter.js';

export interface MigrationChecksumEntry {
  version: string;
  checksumHex: string;
}

export interface MigrationLedgerAssessment {
  state: 'empty' | 'partial' | 'complete';
  pendingVersions: string[];
}

export class MigrationStateError extends Error {
  constructor(readonly reason: string) {
    super(`Migration state is invalid: ${reason}`);
    this.name = 'MigrationStateError';
  }
}

export const assessMigrationLedger = (
  expected: readonly MigrationChecksumEntry[],
  applied: readonly MigrationChecksumEntry[],
): MigrationLedgerAssessment => {
  if (new Set(expected.map((entry) => entry.version)).size !== expected.length) {
    throw new MigrationStateError('expected registry contains duplicate versions');
  }
  if (applied.length > expected.length)
    throw new MigrationStateError('ledger contains unknown versions');
  for (let index = 0; index < applied.length; index += 1) {
    const actual = applied[index]!;
    const wanted = expected[index];
    if (!wanted || actual.version !== wanted.version)
      throw new MigrationStateError('ledger has a hole, unknown version, or order drift');
    if (actual.checksumHex.toLowerCase() !== wanted.checksumHex.toLowerCase()) {
      throw new MigrationStateError(`checksum drift at ${actual.version}`);
    }
  }
  return {
    state:
      applied.length === 0 ? 'empty' : applied.length === expected.length ? 'complete' : 'partial',
    pendingVersions: expected.slice(applied.length).map((entry) => entry.version),
  };
};

interface LedgerRow extends RowDataPacket {
  version: string;
  checksumHex: string;
}

interface LockRow extends RowDataPacket {
  acquired: number | string | null;
}

const LEDGER_BOOTSTRAP_SQL = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version VARCHAR(100) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    checksum BINARY(32) NOT NULL,
    applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    execution_ms INT UNSIGNED NOT NULL,
    PRIMARY KEY (version),
    CONSTRAINT ck_schema_migrations_execution_ms CHECK (execution_ms <= 3600000)
  ) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci
`;

const sha256Hex = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

const loadAsset = async (asset: string): Promise<Buffer> => {
  const bytes = await readFile(new URL(`./sql/${asset}`, import.meta.url));
  new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  return bytes;
};

const expectedChecksums = async (): Promise<
  Array<MigrationChecksumEntry & { entry: MigrationRegistryEntry; bytes: Buffer }>
> =>
  Promise.all(
    MIGRATION_REGISTRY.map(async (entry) => {
      const bytes = await loadAsset(entry.upAsset);
      return { entry, version: entry.version, checksumHex: sha256Hex(bytes), bytes };
    }),
  );

@Injectable()
export class MigrationRunner {
  constructor(@Inject(MysqlService) private readonly mysql: MysqlService) {}

  async status(): Promise<MigrationCertificationStateV1> {
    return this.mysql.withConnection((connection) =>
      this.withMigrationLock(connection, async () => {
        const connectionProfile = await this.mysql.certifyConnection(connection);
        await this.bootstrapLedger(connection);
        const expected = await expectedChecksums();
        const assessment = assessMigrationLedger(
          expected,
          await this.readLedger(connection, expected),
        );
        if (assessment.state !== 'complete')
          throw new MigrationStateError(
            `pending migrations: ${assessment.pendingVersions.join(', ')}`,
          );
        await this.verifyAllPostconditions(connection);
        return { mode: 'restart', registryVersion: MIGRATION_REGISTRY_VERSION, connectionProfile };
      }),
    );
  }

  async up(): Promise<MigrationCertificationStateV1> {
    return this.mysql.withConnection((connection) =>
      this.withMigrationLock(connection, async () => {
        const connectionProfile = await this.mysql.certifyConnection(connection);
        await this.bootstrapLedger(connection);
        const expected = await expectedChecksums();
        const applied = await this.readLedger(connection, expected);
        const assessment = assessMigrationLedger(expected, applied);
        const startedEmpty = assessment.state === 'empty';
        for (let index = applied.length; index < expected.length; index += 1) {
          const migration = expected[index]!;
          const startedAt = performance.now();
          const source = new TextDecoder('utf-8', { fatal: true }).decode(migration.bytes);
          for (const statement of splitSqlStatements(source)) await connection.query(statement);
          await this.verifyPostcondition(connection, migration.entry.postcondition);
          const executionMs = Math.min(
            3_600_000,
            Math.max(0, Math.ceil(performance.now() - startedAt)),
          );
          await connection.execute(
            'INSERT INTO schema_migrations (version, checksum, execution_ms) VALUES (?, UNHEX(?), ?)',
            [migration.version, migration.checksumHex, executionMs],
          );
        }
        const finalAssessment = assessMigrationLedger(
          expected,
          await this.readLedger(connection, expected),
        );
        if (finalAssessment.state !== 'complete')
          throw new MigrationStateError('up did not reach the complete registry');
        await this.verifyAllPostconditions(connection);
        return {
          mode: startedEmpty ? 'fresh' : 'restart',
          registryVersion: MIGRATION_REGISTRY_VERSION,
          connectionProfile,
        };
      }),
    );
  }

  async adopt(version: string): Promise<MigrationCertificationStateV1> {
    if (version !== MIGRATION_REGISTRY_VERSION)
      throw new MigrationStateError('adopt version is not the exact registry version');
    return this.mysql.withConnection((connection) =>
      this.withMigrationLock(connection, async () => {
        const connectionProfile = await this.mysql.certifyConnection(connection);
        await this.bootstrapLedger(connection);
        const expected = await expectedChecksums();
        const applied = await this.readLedger(connection, expected);
        if (applied.length !== 0)
          throw new MigrationStateError('adoption requires an empty ledger');
        await this.verifyAllPostconditions(connection);
        for (const migration of expected) {
          await connection.execute(
            'INSERT INTO schema_migrations (version, checksum, execution_ms) VALUES (?, UNHEX(?), 0)',
            [migration.version, migration.checksumHex],
          );
        }
        return { mode: 'adopt', registryVersion: MIGRATION_REGISTRY_VERSION, connectionProfile };
      }),
    );
  }

  private async bootstrapLedger(connection: PoolConnection): Promise<void> {
    await connection.query(LEDGER_BOOTSTRAP_SQL);
  }

  private async readLedger(
    connection: PoolConnection,
    expected: readonly MigrationChecksumEntry[],
  ): Promise<MigrationChecksumEntry[]> {
    const [rows] = await connection.query<LedgerRow[]>(
      'SELECT version, LOWER(HEX(checksum)) AS checksumHex FROM schema_migrations',
    );
    const byVersion = new Map(rows.map((row) => [row.version, row.checksumHex]));
    for (const version of byVersion.keys()) {
      if (!expected.some((entry) => entry.version === version))
        throw new MigrationStateError(`unknown ledger version: ${version}`);
    }
    return expected.flatMap((entry) => {
      const checksumHex = byVersion.get(entry.version);
      return checksumHex === undefined ? [] : [{ version: entry.version, checksumHex }];
    });
  }

  private async verifyAllPostconditions(connection: PoolConnection): Promise<void> {
    for (const entry of MIGRATION_REGISTRY)
      await this.verifyPostcondition(connection, entry.postcondition);
  }

  private async verifyPostcondition(
    connection: PoolConnection,
    postcondition: string,
  ): Promise<void> {
    const postconditions: Readonly<Record<string, readonly string[]>> = {
      d2_identity_sessions_audit_v1: ['users', 'auth_sessions', 'security_audit_events'],
      d3_boards_v1: ['boards'],
      d2_pairing_grants_v1: [
        'mcp_clients',
        'mcp_grants',
        'pairing_requests',
        'mcp_grant_credentials',
        'mcp_grant_boards',
      ],
      d3_board_revisions_v1: ['board_revisions'],
      d3_board_heads_v1: ['board_heads'],
      d3_board_idempotency_records_v1: ['board_idempotency_records'],
      d3_board_revision_artifact_refs_v1: ['board_revision_artifact_refs'],
      d3_board_event_outbox_v1: ['board_event_outbox'],
      d2_artifact_capability_policy_v1: [
        'board_artifact_capability_policy_epochs',
        'board_artifact_capability_policies',
        'artifact_capability_preauthorization_tickets',
      ],
      d7_artifacts_v1: ['artifacts'],
      d7_artifact_versions_v1: ['artifact_versions'],
      d7_artifact_resources_v1: ['artifact_resources'],
      d7_artifact_runtime_states_v1: ['artifact_runtime_states'],
      d7_artifact_board_usage_v1: ['artifact_board_usage'],
      d8_board_hitl_interactions_v1: ['board_hitl_interactions'],
    };
    const expectedTables = postconditions[postcondition] ?? null;
    if (expectedTables === null)
      throw new MigrationStateError(`unknown postcondition: ${postcondition}`);
    const [rows] = await connection.query<Array<RowDataPacket & { tableName: string }>>(
      `SELECT table_name AS tableName
       FROM information_schema.tables
       WHERE table_schema = DATABASE()
         AND table_name IN (${expectedTables.map(() => '?').join(', ')})`,
      expectedTables,
    );
    const actual = new Set(rows.map((row) => row.tableName));
    for (const table of expectedTables) {
      if (!actual.has(table))
        throw new MigrationStateError(`postcondition is missing table ${table}`);
    }
  }

  private async withMigrationLock<Value>(
    connection: PoolConnection,
    operation: () => Promise<Value>,
  ): Promise<Value> {
    const [rows] = await connection.query<LockRow[]>(
      "SELECT GET_LOCK('leecat-board:migrations:v1', 60) AS acquired",
    );
    if (!isMysqlLockAcquired(rows[0]?.acquired))
      throw new MigrationStateError('migration lock acquisition failed');
    try {
      return await operation();
    } finally {
      await connection.query("SELECT RELEASE_LOCK('leecat-board:migrations:v1')");
    }
  }
}
