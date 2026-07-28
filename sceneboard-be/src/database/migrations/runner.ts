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

export interface V2CheckpointColumnProjection {
  columnName: string;
  columnType: string;
  characterSetName: string | null;
  collationName: string | null;
  isNullable: string;
}

export interface V2CheckpointConstraintProjection {
  constraintName: string;
  checkClause: string;
}

export interface RevisionRetentionColumnProjection {
  tableName: string;
  columnName: string;
  ordinalPosition: number;
  columnType: string;
  characterSetName: string | null;
  collationName: string | null;
  isNullable: string;
  columnDefault: string | null;
  extra: string;
}

export interface RevisionRetentionIndexProjection {
  tableName: string;
  indexName: string;
  nonUnique: number;
  sequence: number;
  columnName: string;
}

export interface RevisionRetentionForeignKeyProjection {
  tableName: string;
  constraintName: string;
  columnName: string;
  referencedTableName: string;
  referencedColumnName: string;
  deleteRule: string;
  sequence: number;
}

export interface RevisionRetentionCheckProjection {
  tableName: string;
  constraintName: string;
  checkClause: string;
}

export interface RevisionRetentionTableProjection {
  tableName: string;
  tableType: string;
  engine: string | null;
  tableCollation: string | null;
}

const RETENTION_TABLES = [
  'board_revision_payloads',
  'board_revision_catalog',
  'board_revision_holds',
  'board_revision_recovery',
] as const;

const expectedRetentionColumns = [
  ['board_revision_payloads', 'revision_pk', 1, 'bigint unsigned', null, null, 'NO'],
  ['board_revision_payloads', 'schema_version', 2, 'char(5)', 'ascii', 'ascii_bin', 'NO'],
  ['board_revision_payloads', 'codec', 3, 'char(1)', 'ascii', 'ascii_bin', 'NO'],
  ['board_revision_payloads', 'canonical_bytes', 4, 'int unsigned', null, null, 'NO'],
  ['board_revision_payloads', 'stored_bytes', 5, 'int unsigned', null, null, 'NO'],
  ['board_revision_payloads', 'payload_sha256', 6, 'binary(32)', null, null, 'NO'],
  ['board_revision_payloads', 'payload', 7, 'longblob', null, null, 'NO'],
  [
    'board_revision_payloads',
    'state',
    8,
    "enum('available','reclaiming')",
    'utf8mb4',
    'utf8mb4_0900_ai_ci',
    'NO',
  ],
  ['board_revision_catalog', 'board_pk', 1, 'bigint unsigned', null, null, 'NO'],
  ['board_revision_catalog', 'revision_pk', 2, 'bigint unsigned', null, null, 'NO'],
  ['board_revision_catalog', 'retained_order', 3, 'bigint unsigned', null, null, 'NO'],
  ['board_revision_catalog', 'is_head', 4, 'tinyint unsigned', null, null, 'NO'],
  ['board_revision_catalog', 'truncated_before', 5, 'tinyint unsigned', null, null, 'NO'],
  ['board_revision_catalog', 'created_at', 6, 'datetime(3)', null, null, 'NO'],
  ['board_revision_holds', 'board_pk', 1, 'bigint unsigned', null, null, 'NO'],
  ['board_revision_holds', 'revision_pk', 2, 'bigint unsigned', null, null, 'NO'],
  [
    'board_revision_holds',
    'kind',
    3,
    "enum('published','media','artifact','idempotency','outbox','recovery','restore')",
    'utf8mb4',
    'utf8mb4_0900_ai_ci',
    'NO',
  ],
  ['board_revision_holds', 'holder_id', 4, 'varchar(191)', 'ascii', 'ascii_bin', 'NO'],
  ['board_revision_holds', 'expires_at', 5, 'datetime(3)', null, null, 'YES'],
  ['board_revision_holds', 'released_at', 6, 'datetime(3)', null, null, 'YES'],
  ['board_revision_recovery', 'recovery_id', 1, 'varchar(191)', 'ascii', 'ascii_bin', 'NO'],
  ['board_revision_recovery', 'board_pk', 2, 'bigint unsigned', null, null, 'NO'],
  ['board_revision_recovery', 'revision_pk', 3, 'bigint unsigned', null, null, 'NO'],
  [
    'board_revision_recovery',
    'phase',
    4,
    "enum('planned','core_applied','refs_detached','payload_cleared','catalog_removed','complete','quarantined')",
    'utf8mb4',
    'utf8mb4_0900_ai_ci',
    'NO',
  ],
  ['board_revision_recovery', 'lease_owner', 5, 'varchar(191)', 'ascii', 'ascii_bin', 'YES'],
  ['board_revision_recovery', 'lease_expires_at', 6, 'datetime(3)', null, null, 'YES'],
  ['board_revision_recovery', 'attempts', 7, 'smallint unsigned', null, null, 'NO'],
  [
    'board_revision_recovery',
    'last_error',
    8,
    'varchar(1024)',
    'utf8mb4',
    'utf8mb4_0900_ai_ci',
    'YES',
  ],
  ['board_revision_recovery', 'updated_at', 9, 'datetime(3)', null, null, 'NO'],
] as const;

const expectedRetentionIndexes = [
  ['board_revision_payloads', 'PRIMARY', 0, 1, 'revision_pk'],
  ['board_revision_payloads', 'ix_revision_payloads_state', 1, 1, 'state'],
  ['board_revision_payloads', 'ix_revision_payloads_state', 1, 2, 'revision_pk'],
  ['board_revision_catalog', 'PRIMARY', 0, 1, 'board_pk'],
  ['board_revision_catalog', 'PRIMARY', 0, 2, 'revision_pk'],
  ['board_revision_catalog', 'uq_revision_catalog_order', 0, 1, 'board_pk'],
  ['board_revision_catalog', 'uq_revision_catalog_order', 0, 2, 'retained_order'],
  ['board_revision_catalog', 'ix_revision_catalog_head', 1, 1, 'board_pk'],
  ['board_revision_catalog', 'ix_revision_catalog_head', 1, 2, 'is_head'],
  ['board_revision_catalog', 'ix_revision_catalog_head', 1, 3, 'retained_order'],
  ['board_revision_holds', 'PRIMARY', 0, 1, 'board_pk'],
  ['board_revision_holds', 'PRIMARY', 0, 2, 'revision_pk'],
  ['board_revision_holds', 'PRIMARY', 0, 3, 'kind'],
  ['board_revision_holds', 'PRIMARY', 0, 4, 'holder_id'],
  ['board_revision_holds', 'ix_revision_holds_active', 1, 1, 'board_pk'],
  ['board_revision_holds', 'ix_revision_holds_active', 1, 2, 'released_at'],
  ['board_revision_holds', 'ix_revision_holds_active', 1, 3, 'expires_at'],
  ['board_revision_holds', 'ix_revision_holds_active', 1, 4, 'revision_pk'],
  ['board_revision_recovery', 'PRIMARY', 0, 1, 'recovery_id'],
  ['board_revision_recovery', 'ix_revision_recovery_discovery', 1, 1, 'phase'],
  ['board_revision_recovery', 'ix_revision_recovery_discovery', 1, 2, 'lease_expires_at'],
  ['board_revision_recovery', 'ix_revision_recovery_discovery', 1, 3, 'recovery_id'],
  ['board_revision_recovery', 'ix_revision_recovery_revision', 1, 1, 'board_pk'],
  ['board_revision_recovery', 'ix_revision_recovery_revision', 1, 2, 'revision_pk'],
  ['board_revision_recovery', 'ix_revision_recovery_revision', 1, 3, 'phase'],
] as const;

const expectedRetentionForeignKeys = [
  [
    'board_revision_payloads',
    'fk_revision_payloads_revision',
    'revision_pk',
    'board_revisions',
    'revision_pk',
    'RESTRICT',
    1,
  ],
  [
    'board_revision_catalog',
    'fk_revision_catalog_revision',
    'board_pk',
    'board_revisions',
    'board_pk',
    'RESTRICT',
    1,
  ],
  [
    'board_revision_catalog',
    'fk_revision_catalog_revision',
    'revision_pk',
    'board_revisions',
    'revision_pk',
    'RESTRICT',
    2,
  ],
  [
    'board_revision_holds',
    'fk_revision_holds_revision',
    'board_pk',
    'board_revisions',
    'board_pk',
    'RESTRICT',
    1,
  ],
  [
    'board_revision_holds',
    'fk_revision_holds_revision',
    'revision_pk',
    'board_revisions',
    'revision_pk',
    'RESTRICT',
    2,
  ],
  [
    'board_revision_recovery',
    'fk_revision_recovery_revision',
    'board_pk',
    'board_revisions',
    'board_pk',
    'RESTRICT',
    1,
  ],
  [
    'board_revision_recovery',
    'fk_revision_recovery_revision',
    'revision_pk',
    'board_revisions',
    'revision_pk',
    'RESTRICT',
    2,
  ],
] as const;

const expectedRetentionChecks: Readonly<Record<string, readonly string[]>> = {
  'board_revision_payloads.chk_revision_payloads_checkpoint': [
    "codec='b'",
    'stored_bytes=octet_length(payload)',
    "schema_version='1.0.0'",
    'canonical_bytesbetween1and786432',
    'stored_bytesbetween1and800000',
    "schema_version='2.0.0'",
    'canonical_bytesbetween1and20971520',
    'stored_bytesbetween1and33554432',
  ],
  'board_revision_payloads.chk_revision_payloads_state': ["statein('available','reclaiming')"],
  'board_revision_catalog.chk_revision_catalog_order': [
    'retained_orderbetween1and9007199254740991',
  ],
  'board_revision_catalog.chk_revision_catalog_flags': [
    'is_headin(0,1)',
    'truncated_beforein(0,1)',
  ],
  'board_revision_holds.chk_revision_holds_kind': [
    "kindin('published','media','artifact','idempotency','outbox','recovery','restore')",
  ],
  'board_revision_holds.chk_revision_holds_holder': ['char_length(holder_id)between1and191'],
  'board_revision_recovery.chk_revision_recovery_phase': [
    "phasein('planned','core_applied','refs_detached','payload_cleared','catalog_removed','complete','quarantined')",
  ],
  'board_revision_recovery.chk_revision_recovery_lease': [
    'lease_ownerisnull',
    'lease_expires_atisnull',
    'lease_ownerisnotnull',
    'lease_expires_atisnotnull',
  ],
  'board_revision_recovery.chk_revision_recovery_complete': [
    "phase<>'complete'",
    'lease_ownerisnull',
    'lease_expires_atisnull',
  ],
  'board_revision_recovery.chk_revision_recovery_attempts': ['attempts<=65535'],
  'board_revision_recovery.chk_revision_recovery_id': ['char_length(recovery_id)between1and191'],
};

const projectionKey = (values: readonly unknown[]): string => JSON.stringify(values);

const assertExactProjection = (
  label: string,
  expected: readonly (readonly unknown[])[],
  actual: readonly (readonly unknown[])[],
): void => {
  const expectedKeys = expected.map(projectionKey).sort();
  const actualKeys = actual.map(projectionKey).sort();
  if (
    expectedKeys.length !== actualKeys.length ||
    expectedKeys.some((entry, index) => entry !== actualKeys[index])
  ) {
    throw new MigrationStateError(`${label} projection drift`);
  }
};

const normalizeCheckClause = (clause: string): string =>
  clause
    .toLowerCase()
    .replaceAll('`', '')
    .replaceAll(/_(?:utf8mb4|ascii)(?=')/gu, '')
    .replaceAll(/\s+/gu, '');

export const assessRevisionRetentionExpand = (
  columnRows: readonly RevisionRetentionColumnProjection[],
  indexRows: readonly RevisionRetentionIndexProjection[],
  foreignKeyRows: readonly RevisionRetentionForeignKeyProjection[],
  checkRows: readonly RevisionRetentionCheckProjection[],
  tableRows: readonly RevisionRetentionTableProjection[],
): void => {
  assertExactProjection(
    'revision retention table',
    RETENTION_TABLES.map((tableName) => [tableName, 'BASE TABLE', 'InnoDB', 'utf8mb4_0900_ai_ci']),
    tableRows.map((row) => [row.tableName, row.tableType, row.engine, row.tableCollation]),
  );
  assertExactProjection(
    'revision retention column',
    expectedRetentionColumns,
    columnRows.map((row) => [
      row.tableName,
      row.columnName,
      Number(row.ordinalPosition),
      row.columnType.toLowerCase(),
      row.characterSetName,
      row.collationName,
      row.isNullable,
    ]),
  );
  if (columnRows.some((row) => row.columnDefault !== null || row.extra !== '')) {
    throw new MigrationStateError('revision retention column default or extra drift');
  }
  assertExactProjection(
    'revision retention index',
    expectedRetentionIndexes,
    indexRows.map((row) => [
      row.tableName,
      row.indexName,
      Number(row.nonUnique),
      Number(row.sequence),
      row.columnName,
    ]),
  );
  assertExactProjection(
    'revision retention foreign key',
    expectedRetentionForeignKeys,
    foreignKeyRows.map((row) => [
      row.tableName,
      row.constraintName,
      row.columnName,
      row.referencedTableName,
      row.referencedColumnName,
      row.deleteRule,
      Number(row.sequence),
    ]),
  );

  const checks = new Map(
    checkRows.map((row) => [
      `${row.tableName}.${row.constraintName}`,
      normalizeCheckClause(row.checkClause),
    ]),
  );
  const expectedNames = Object.keys(expectedRetentionChecks).sort();
  if (
    checks.size !== expectedNames.length ||
    [...checks.keys()].sort().some((name, index) => name !== expectedNames[index])
  ) {
    throw new MigrationStateError('revision retention CHECK name drift');
  }
  for (const [name, fragments] of Object.entries(expectedRetentionChecks)) {
    const clause = checks.get(name) ?? '';
    for (const fragment of fragments) {
      if (!clause.includes(fragment)) {
        throw new MigrationStateError(`revision retention CHECK drift: ${name}`);
      }
    }
  }
};

export const assessV2CheckpointCapacity = (
  columnRows: readonly V2CheckpointColumnProjection[],
  constraintRows: readonly V2CheckpointConstraintProjection[],
): void => {
  const columns = new Map(columnRows.map((row) => [row.columnName, row]));
  const expected = {
    scene_schema_version: ['char(5)', 'ascii', 'ascii_bin', 'NO'],
    scene_codec: ['char(1)', 'ascii', 'ascii_bin', 'NO'],
    scene_payload: ['longblob', null, null, 'NO'],
    scene_canonical_bytes: ['int unsigned', null, null, 'NO'],
    scene_stored_bytes: ['int unsigned', null, null, 'NO'],
  } as const;
  for (const [name, values] of Object.entries(expected)) {
    const actual = columns.get(name);
    if (
      actual === undefined ||
      actual.columnType.toLowerCase() !== values[0] ||
      actual.characterSetName !== values[1] ||
      actual.collationName !== values[2] ||
      actual.isNullable !== values[3]
    ) {
      throw new MigrationStateError(`v2 checkpoint column drift: ${name}`);
    }
  }

  const constraints = new Map(
    constraintRows.map((row) => [
      row.constraintName,
      row.checkClause.toLowerCase().replaceAll(/\s+/g, ''),
    ]),
  );
  const checkpoint = constraints.get('chk_revisions_checkpoint') ?? '';
  for (const required of [
    "scene_codec='b'",
    'scene_stored_bytes=octet_length(scene_payload)',
    "scene_schema_version='1.0.0'",
    'scene_canonical_bytesbetween1and786432',
    'scene_stored_bytesbetween1and800000',
    "scene_schema_version='2.0.0'",
    'scene_canonical_bytesbetween1and20971520',
    'scene_stored_bytesbetween1and33554432',
  ]) {
    if (!checkpoint.includes(required))
      throw new MigrationStateError(`v2 checkpoint predicate drift: ${required}`);
  }
  if (
    !constraints.get('chk_revisions_codec')?.includes("scene_codec='b'") ||
    !constraints.get('chk_revisions_origin')?.includes("'d'")
  ) {
    throw new MigrationStateError('v2 checkpoint discriminator constraints are missing');
  }
};

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
    if (postcondition === 'd9_v2_checkpoint_capacity_v1') {
      await this.verifyV2CheckpointCapacity(connection);
      return;
    }
    if (postcondition === 'd9_revision_retention_expand_v1') {
      await this.verifyRevisionRetentionExpand(connection);
      return;
    }
    if (postcondition === 'd9_board_invitations_v1') {
      await this.verifyInvitationSchema(connection);
      return;
    }
    if (postcondition === 'd9_board_shares_v1') {
      await this.verifyShareSchema(connection);
      return;
    }
    if (postcondition === 'd9_share_password_auth_v1') {
      await this.verifySharePasswordSchema(connection);
      return;
    }
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
      d9_revision_retention_runtime_v1: [
        'board_retention_leases',
        'board_retention_runs',
        'board_retention_run_items',
        'board_retention_audit',
        'retention_restore_drill_attempts',
      ],
      d9_board_memberships_v1: ['board_memberships'],
      d9_board_invitations_v1: ['board_invitations'],
      d9_board_shares_v1: [
        'board_shares',
        'share_transition_recovery',
        'share_transition_recovery_items',
        'share_request_idempotency',
      ],
      d9_share_password_auth_v1: [
        'share_password_credentials',
        'share_password_session_families',
        'share_password_session_grants',
        'share_password_cleanup_leases',
      ],
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

  private async verifyV2CheckpointCapacity(connection: PoolConnection): Promise<void> {
    const [columnRows] = await connection.query<
      Array<RowDataPacket & V2CheckpointColumnProjection>
    >(
      `SELECT
         column_name AS columnName,
         column_type AS columnType,
         character_set_name AS characterSetName,
         collation_name AS collationName,
         is_nullable AS isNullable
       FROM information_schema.columns
       WHERE table_schema = DATABASE()
         AND table_name = 'board_revisions'
         AND column_name IN (
           'scene_schema_version',
           'scene_codec',
           'scene_payload',
           'scene_canonical_bytes',
           'scene_stored_bytes'
         )`,
    );
    const [constraintRows] = await connection.query<
      Array<RowDataPacket & V2CheckpointConstraintProjection>
    >(
      `SELECT
         tc.constraint_name AS constraintName,
         cc.check_clause AS checkClause
       FROM information_schema.table_constraints tc
       JOIN information_schema.check_constraints cc
         ON cc.constraint_schema = tc.constraint_schema
           AND cc.constraint_name = tc.constraint_name
       WHERE tc.table_schema = DATABASE()
         AND tc.table_name = 'board_revisions'
         AND tc.constraint_type = 'CHECK'
         AND tc.constraint_name IN (
           'chk_revisions_origin',
           'chk_revisions_codec',
           'chk_revisions_checkpoint'
         )`,
    );
    assessV2CheckpointCapacity(columnRows, constraintRows);
  }

  private async verifyInvitationSchema(connection: PoolConnection): Promise<void> {
    const [columns] = await connection.query<
      Array<
        RowDataPacket & {
          columnType: string;
          isNullable: string;
          columnDefault: string | null;
        }
      >
    >(
      `SELECT column_type AS columnType, is_nullable AS isNullable,
              column_default AS columnDefault
       FROM information_schema.columns
       WHERE table_schema = DATABASE()
         AND table_name = 'boards'
         AND column_name = 'capability_epoch'`,
    );
    const epoch = columns[0];
    if (
      columns.length !== 1 ||
      epoch === undefined ||
      epoch.columnType.toLowerCase() !== 'bigint unsigned' ||
      epoch.isNullable !== 'NO' ||
      String(epoch.columnDefault) !== '0'
    ) {
      throw new MigrationStateError('board capability epoch projection mismatch');
    }
    const [indexes] = await connection.query<
      Array<RowDataPacket & { indexName: string; nonUnique: number; columns: string }>
    >(
      `SELECT index_name AS indexName, non_unique AS nonUnique,
              GROUP_CONCAT(column_name ORDER BY seq_in_index SEPARATOR ',') AS columns
       FROM information_schema.statistics
       WHERE table_schema = DATABASE()
         AND table_name = 'board_invitations'
         AND index_name IN (
           'uq_board_invitations_token_locator',
           'uq_board_invitations_token_digest',
           'uq_board_invitations_active_email'
         )
       GROUP BY index_name, non_unique`,
    );
    const actual = new Map(
      indexes.map((index) => [index.indexName, `${index.nonUnique}:${index.columns}`]),
    );
    const expected = new Map([
      ['uq_board_invitations_token_locator', '0:token_locator'],
      ['uq_board_invitations_token_digest', '0:token_digest'],
      ['uq_board_invitations_active_email', '0:board_pk,active_email_normalized'],
    ]);
    if (
      actual.size !== expected.size ||
      [...expected].some(([name, value]) => actual.get(name) !== value)
    ) {
      throw new MigrationStateError('board invitation index projection mismatch');
    }
  }

  private async verifyShareSchema(connection: PoolConnection): Promise<void> {
    const expectedTables = [
      'board_shares',
      'share_transition_recovery',
      'share_transition_recovery_items',
      'share_request_idempotency',
    ] as const;
    const [tables] = await connection.query<Array<RowDataPacket & { tableName: string }>>(
      `SELECT table_name AS tableName
       FROM information_schema.tables
       WHERE table_schema = DATABASE()
         AND table_name IN (${expectedTables.map(() => '?').join(', ')})`,
      expectedTables,
    );
    if (new Set(tables.map((row) => row.tableName)).size !== expectedTables.length) {
      throw new MigrationStateError('board share table projection mismatch');
    }
    const [recoveryColumns] = await connection.query<
      Array<RowDataPacket & { columnName: string; columnType: string; isNullable: string }>
    >(
      `SELECT column_name AS columnName, column_type AS columnType,
              is_nullable AS isNullable
       FROM information_schema.columns
       WHERE table_schema = DATABASE()
         AND table_name = 'share_transition_recovery'
         AND column_name IN (
           'credential_present',
           'credential_version',
           'password_hash_sha256',
           'pepper_version',
           'operator_fence',
           'operator_claimant',
           'operator_evidence_sha256'
         )`,
    );
    const recoveryProjection = new Map(
      recoveryColumns.map((column) => [
        column.columnName,
        `${column.columnType.toLowerCase()}:${column.isNullable}`,
      ]),
    );
    const expectedRecoveryProjection = new Map([
      ['credential_present', 'tinyint unsigned:NO'],
      ['credential_version', 'bigint unsigned:YES'],
      ['password_hash_sha256', 'binary(32):YES'],
      ['pepper_version', 'smallint unsigned:YES'],
      ['operator_fence', 'bigint unsigned:NO'],
      ['operator_claimant', 'varchar(191):YES'],
      ['operator_evidence_sha256', 'binary(32):YES'],
    ]);
    if (
      recoveryProjection.size !== expectedRecoveryProjection.size ||
      [...expectedRecoveryProjection].some(
        ([name, value]) => recoveryProjection.get(name) !== value,
      )
    ) {
      throw new MigrationStateError('board share recovery projection mismatch');
    }
    const [indexes] = await connection.query<
      Array<RowDataPacket & { indexName: string; nonUnique: number; columns: string }>
    >(
      `SELECT index_name AS indexName, non_unique AS nonUnique,
              GROUP_CONCAT(column_name ORDER BY seq_in_index SEPARATOR ',') AS columns
       FROM information_schema.statistics
       WHERE table_schema = DATABASE()
         AND table_name = 'board_shares'
         AND index_name IN (
           'uq_board_shares_share_id',
           'uq_board_shares_board',
           'uq_board_shares_token_digest'
         )
       GROUP BY index_name, non_unique`,
    );
    const actual = new Map(
      indexes.map((index) => [index.indexName, `${index.nonUnique}:${index.columns}`]),
    );
    const expected = new Map([
      ['uq_board_shares_share_id', '0:share_id'],
      ['uq_board_shares_board', '0:board_pk'],
      ['uq_board_shares_token_digest', '0:token_digest'],
    ]);
    if (
      actual.size !== expected.size ||
      [...expected].some(([name, value]) => actual.get(name) !== value)
    ) {
      throw new MigrationStateError('board share index projection mismatch');
    }
  }

  private async verifySharePasswordSchema(connection: PoolConnection): Promise<void> {
    const expectedTables = [
      'share_password_credentials',
      'share_password_session_families',
      'share_password_session_grants',
      'share_password_cleanup_leases',
    ] as const;
    const [tables] = await connection.query<Array<RowDataPacket & { tableName: string }>>(
      `SELECT table_name AS tableName
       FROM information_schema.tables
       WHERE table_schema = DATABASE()
         AND table_name IN (${expectedTables.map(() => '?').join(', ')})`,
      expectedTables,
    );
    if (new Set(tables.map((row) => row.tableName)).size !== expectedTables.length) {
      throw new MigrationStateError('share password table projection mismatch');
    }
    const [columns] = await connection.query<
      Array<
        RowDataPacket & {
          tableName: string;
          columnName: string;
          columnType: string;
          isNullable: string;
        }
      >
    >(
      `SELECT table_name AS tableName, column_name AS columnName,
              column_type AS columnType, is_nullable AS isNullable
       FROM information_schema.columns
       WHERE table_schema = DATABASE()
         AND (
           (table_name = 'share_password_credentials'
             AND column_name IN (
               'share_pk','password_hash','salt','hash_version','pepper_version',
               'credential_version','created_at','updated_at'
             ))
           OR
           (table_name = 'share_password_session_grants'
             AND column_name IN (
               'family_digest','share_pk','access_generation','credential_version',
               'expires_at','created_at'
             ))
         )`,
    );
    const actual = new Map(
      columns.map((column) => [
        `${column.tableName}.${column.columnName}`,
        `${column.columnType.toLowerCase()}:${column.isNullable}`,
      ]),
    );
    const expected = new Map([
      ['share_password_credentials.share_pk', 'bigint unsigned:NO'],
      ['share_password_credentials.password_hash', 'binary(32):NO'],
      ['share_password_credentials.salt', 'binary(16):NO'],
      ['share_password_credentials.hash_version', 'char(2):NO'],
      ['share_password_credentials.pepper_version', 'smallint unsigned:NO'],
      ['share_password_credentials.credential_version', 'bigint unsigned:NO'],
      ['share_password_credentials.created_at', 'datetime(6):NO'],
      ['share_password_credentials.updated_at', 'datetime(6):NO'],
      ['share_password_session_grants.family_digest', 'binary(32):NO'],
      ['share_password_session_grants.share_pk', 'bigint unsigned:NO'],
      ['share_password_session_grants.access_generation', 'bigint unsigned:NO'],
      ['share_password_session_grants.credential_version', 'bigint unsigned:NO'],
      ['share_password_session_grants.expires_at', 'datetime(6):NO'],
      ['share_password_session_grants.created_at', 'datetime(6):NO'],
    ]);
    if (
      actual.size !== expected.size ||
      [...expected].some(([name, value]) => actual.get(name) !== value)
    ) {
      throw new MigrationStateError('share password column projection mismatch');
    }
    const [enums] = await connection.query<
      Array<RowDataPacket & { tableName: string; columnName: string; columnType: string }>
    >(
      `SELECT table_name AS tableName, column_name AS columnName, column_type AS columnType
       FROM information_schema.columns
       WHERE table_schema = DATABASE()
         AND (
           (table_name = 'share_transition_recovery' AND column_name = 'operation')
           OR
           (table_name = 'share_request_idempotency'
             AND column_name IN ('operation','result_kind'))
         )`,
    );
    const enumText = enums.map((row) => `${row.tableName}.${row.columnName}:${row.columnType}`);
    for (const required of [
      'password.enable',
      'password.regenerate',
      'password.disable',
      'password-enabled',
      'password-regenerated',
      'password-disabled',
    ]) {
      if (!enumText.some((value) => value.includes(`'${required}'`))) {
        throw new MigrationStateError(`share password enum projection is missing ${required}`);
      }
    }
  }

  private async verifyRevisionRetentionExpand(connection: PoolConnection): Promise<void> {
    const placeholders = RETENTION_TABLES.map(() => '?').join(', ');
    const [tableRows] = await connection.query<
      Array<RowDataPacket & RevisionRetentionTableProjection>
    >(
      `SELECT
         table_name AS tableName,
         table_type AS tableType,
         engine,
         table_collation AS tableCollation
       FROM information_schema.tables
       WHERE table_schema = DATABASE()
         AND table_name IN (${placeholders})`,
      RETENTION_TABLES,
    );
    const [columnRows] = await connection.query<
      Array<RowDataPacket & RevisionRetentionColumnProjection>
    >(
      `SELECT
         table_name AS tableName,
         column_name AS columnName,
         ordinal_position AS ordinalPosition,
         column_type AS columnType,
         character_set_name AS characterSetName,
         collation_name AS collationName,
         is_nullable AS isNullable,
         column_default AS columnDefault,
         extra
       FROM information_schema.columns
       WHERE table_schema = DATABASE()
         AND table_name IN (${placeholders})`,
      RETENTION_TABLES,
    );
    const [indexRows] = await connection.query<
      Array<RowDataPacket & RevisionRetentionIndexProjection>
    >(
      `SELECT
         table_name AS tableName,
         index_name AS indexName,
         non_unique AS nonUnique,
         seq_in_index AS sequence,
         column_name AS columnName
       FROM information_schema.statistics
       WHERE table_schema = DATABASE()
         AND table_name IN (${placeholders})`,
      RETENTION_TABLES,
    );
    const [foreignKeyRows] = await connection.query<
      Array<RowDataPacket & RevisionRetentionForeignKeyProjection>
    >(
      `SELECT
         kcu.table_name AS tableName,
         kcu.constraint_name AS constraintName,
         kcu.column_name AS columnName,
         kcu.referenced_table_name AS referencedTableName,
         kcu.referenced_column_name AS referencedColumnName,
         rc.delete_rule AS deleteRule,
         kcu.ordinal_position AS sequence
       FROM information_schema.key_column_usage kcu
       JOIN information_schema.referential_constraints rc
         ON rc.constraint_schema = kcu.constraint_schema
           AND rc.constraint_name = kcu.constraint_name
       WHERE kcu.table_schema = DATABASE()
         AND kcu.table_name IN (${placeholders})
         AND kcu.referenced_table_name IS NOT NULL`,
      RETENTION_TABLES,
    );
    const [checkRows] = await connection.query<
      Array<RowDataPacket & RevisionRetentionCheckProjection>
    >(
      `SELECT
         tc.table_name AS tableName,
         tc.constraint_name AS constraintName,
         cc.check_clause AS checkClause
       FROM information_schema.table_constraints tc
       JOIN information_schema.check_constraints cc
         ON cc.constraint_schema = tc.constraint_schema
           AND cc.constraint_name = tc.constraint_name
       WHERE tc.table_schema = DATABASE()
         AND tc.table_name IN (${placeholders})
         AND tc.constraint_type = 'CHECK'`,
      RETENTION_TABLES,
    );
    assessRevisionRetentionExpand(columnRows, indexRows, foreignKeyRows, checkRows, tableRows);
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
