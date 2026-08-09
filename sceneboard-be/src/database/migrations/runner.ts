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
import {
  verifyAccountApiKeyPostcondition,
  verifyAccountApiKeyScopeCapacityPostcondition,
  verifyDocumentReplaceIdempotencyPostcondition,
  verifyDocumentV3CheckpointPostcondition,
  verifyExportTerminalAuditPostcondition,
  verifyRevisionExportHoldPostcondition,
} from './postconditions.js';

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
    .replaceAll(/\\'/gu, "'")
    .replaceAll(/_(?:utf8mb4|ascii)(?=')/gu, '')
    .replaceAll(/(?<![a-z0-9_])length\(/gu, 'octet_length(')
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
  const runtimeActorColumns = columnRows.filter(
    (row) =>
      row.tableName === 'board_revision_catalog' &&
      ['actor_account_pk', 'actor_class'].includes(row.columnName),
  );
  const runtimeActorProjection = runtimeActorColumns.length > 0;
  const exportHoldProjection = columnRows.some(
    (row) =>
      row.tableName === 'board_revision_holds' &&
      row.columnName === 'kind' &&
      row.columnType.toLowerCase().includes(",'export'"),
  );
  if (runtimeActorProjection) {
    assertExactProjection(
      'revision retention runtime actor column',
      [
        ['actor_account_pk', 6, 'bigint unsigned', null, null, 'YES'],
        [
          'actor_class',
          7,
          "enum('owner','editor','system')",
          'utf8mb4',
          'utf8mb4_0900_ai_ci',
          'NO',
        ],
      ],
      runtimeActorColumns.map((row) => [
        row.columnName,
        Number(row.ordinalPosition),
        row.columnType.toLowerCase(),
        row.characterSetName,
        row.collationName,
        row.isNullable,
      ]),
    );
  }
  const baseColumnRows = columnRows
    .filter(
      (row) =>
        row.tableName !== 'board_revision_catalog' ||
        !['actor_account_pk', 'actor_class'].includes(row.columnName),
    )
    .map((row) => {
      if (
        runtimeActorProjection &&
        row.tableName === 'board_revision_catalog' &&
        row.columnName === 'created_at'
      ) {
        return { ...row, ordinalPosition: 6 };
      }
      if (
        exportHoldProjection &&
        row.tableName === 'board_revision_holds' &&
        row.columnName === 'kind'
      ) {
        return { ...row, columnType: row.columnType.replace(",'export'", '') };
      }
      return row;
    });
  assertExactProjection(
    'revision retention column',
    expectedRetentionColumns,
    baseColumnRows.map((row) => [
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
  const runtimeActorIndexes = indexRows.filter(
    (row) =>
      row.tableName === 'board_revision_catalog' && row.indexName === 'ix_revision_catalog_actor',
  );
  if (runtimeActorProjection) {
    assertExactProjection(
      'revision retention runtime actor index',
      [
        [1, 1, 'actor_account_pk'],
        [1, 2, 'board_pk'],
        [1, 3, 'retained_order'],
      ],
      runtimeActorIndexes.map((row) => [
        Number(row.nonUnique),
        Number(row.sequence),
        row.columnName,
      ]),
    );
  }
  const recoveryIdentityIndexes = indexRows.filter(
    (row) =>
      row.tableName === 'board_revision_recovery' &&
      row.indexName === 'uq_revision_recovery_identity',
  );
  if (recoveryIdentityIndexes.length > 0) {
    assertExactProjection(
      'revision retention share recovery identity index',
      [
        [0, 1, 'recovery_id'],
        [0, 2, 'board_pk'],
        [0, 3, 'revision_pk'],
      ],
      recoveryIdentityIndexes.map((row) => [
        Number(row.nonUnique),
        Number(row.sequence),
        row.columnName,
      ]),
    );
  }
  assertExactProjection(
    'revision retention index',
    expectedRetentionIndexes,
    indexRows
      .filter(
        (row) =>
          !(
            row.tableName === 'board_revision_catalog' &&
            row.indexName === 'ix_revision_catalog_actor'
          ) &&
          !(
            row.tableName === 'board_revision_recovery' &&
            row.indexName === 'uq_revision_recovery_identity'
          ),
      )
      .map((row) => [
        row.tableName,
        row.indexName,
        Number(row.nonUnique),
        Number(row.sequence),
        row.columnName,
      ]),
  );
  const runtimeActorForeignKeys = foreignKeyRows.filter(
    (row) =>
      row.tableName === 'board_revision_catalog' &&
      row.constraintName === 'fk_revision_catalog_actor',
  );
  if (runtimeActorProjection) {
    assertExactProjection(
      'revision retention runtime actor foreign key',
      [['actor_account_pk', 'users', 'id', 'RESTRICT', 1]],
      runtimeActorForeignKeys.map((row) => [
        row.columnName,
        row.referencedTableName,
        row.referencedColumnName,
        row.deleteRule,
        Number(row.sequence),
      ]),
    );
  }
  assertExactProjection(
    'revision retention foreign key',
    expectedRetentionForeignKeys,
    foreignKeyRows
      .filter(
        (row) =>
          row.tableName !== 'board_revision_catalog' ||
          row.constraintName !== 'fk_revision_catalog_actor',
      )
      .map((row) => [
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
    checkRows.map((row) => {
      const name = `${row.tableName}.${row.constraintName}`;
      const clause = normalizeCheckClause(row.checkClause);
      return [
        name,
        exportHoldProjection && name === 'board_revision_holds.chk_revision_holds_kind'
          ? clause.replace(",'export'", '')
          : clause,
      ];
    }),
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
    scene_schema_version: ['char(5)', 'ascii', 'ascii_bin'],
    scene_codec: ['char(1)', 'ascii', 'ascii_bin'],
    scene_payload: ['longblob', null, null],
    scene_canonical_bytes: ['int unsigned', null, null],
    scene_stored_bytes: ['int unsigned', null, null],
  } as const;
  const nullability = new Set<string>();
  for (const [name, values] of Object.entries(expected)) {
    const actual = columns.get(name);
    if (
      actual === undefined ||
      actual.columnType.toLowerCase() !== values[0] ||
      actual.characterSetName !== values[1] ||
      actual.collationName !== values[2] ||
      !['NO', 'YES'].includes(actual.isNullable)
    ) {
      throw new MigrationStateError(`v2 checkpoint column drift: ${name}`);
    }
    nullability.add(actual.isNullable);
  }
  if (nullability.size !== 1)
    throw new MigrationStateError('v2 checkpoint column nullability drift');
  const retainedProjection = nullability.has('YES');

  const constraints = new Map(
    constraintRows.map((row) => [row.constraintName, normalizeCheckClause(row.checkClause)]),
  );
  const checkpointName = retainedProjection
    ? 'chk_revisions_retained_checkpoint'
    : 'chk_revisions_checkpoint';
  const checkpoint = constraints.get(checkpointName) ?? '';
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
    retainedProjection &&
    [
      'scene_schema_versionisnull',
      'scene_codecisnull',
      'scene_payloadisnull',
      'scene_canonical_bytesisnull',
      'scene_stored_bytesisnull',
    ].some((required) => !checkpoint.includes(required))
  ) {
    throw new MigrationStateError('v2 retained checkpoint null projection drift');
  }
  if (
    (!retainedProjection && !constraints.get('chk_revisions_codec')?.includes("scene_codec='b'")) ||
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

export const isRecoverableAccountApiKeyTableExists = (
  version: string,
  statement: string,
  error: unknown,
): boolean =>
  version === '025_d10_account_api_keys' &&
  /^CREATE\s+TABLE\s+`?account_api_keys`?\s*\(/iu.test(statement.trim()) &&
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  error.code === 'ER_TABLE_EXISTS_ERROR' &&
  'errno' in error &&
  error.errno === 1050;

export const isRecoverableExportTerminalAuditTableExists = (
  version: string,
  statement: string,
  error: unknown,
): boolean =>
  version === '029_d10_export_terminal_audit' &&
  /^CREATE\s+TABLE\s+`?export_terminal_audit_intents`?\s*\(/iu.test(statement.trim()) &&
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  error.code === 'ER_TABLE_EXISTS_ERROR' &&
  'errno' in error &&
  error.errno === 1050;

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
          for (const statement of splitSqlStatements(source)) {
            try {
              await connection.query(statement);
            } catch (error) {
              if (isRecoverableAccountApiKeyTableExists(migration.version, statement, error))
                continue;
              if (
                isRecoverableExportTerminalAuditTableExists(migration.version, statement, error)
              ) {
                await verifyExportTerminalAuditPostcondition(connection);
                continue;
              }
              throw error;
            }
          }
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
    if (postcondition === 'd10_account_api_key_scope_capacity_v1') {
      await verifyAccountApiKeyScopeCapacityPostcondition(connection);
      return;
    }
    if (postcondition === 'd10_revision_retention_backfill_v1') {
      await this.verifyRevisionRetentionBackfill(connection);
      return;
    }
    if (postcondition === 'd10_document_replace_idempotency_v1') {
      await verifyDocumentReplaceIdempotencyPostcondition(connection);
      return;
    }
    if (postcondition === 'd10_revision_export_hold_v1') {
      await verifyRevisionExportHoldPostcondition(connection);
      return;
    }
    if (postcondition === 'd10_document_v3_checkpoint_v1') {
      await verifyDocumentV3CheckpointPostcondition(connection);
      return;
    }
    if (postcondition === 'd10_account_api_keys_v1') {
      await verifyAccountApiKeyPostcondition(connection);
      return;
    }
    if (postcondition === 'd10_export_terminal_audit_v1') {
      await verifyExportTerminalAuditPostcondition(connection);
      return;
    }
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
    if (postcondition === 'd9_board_revision_media_refs_v1') {
      await this.verifyRevisionMediaRefsSchema(connection);
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
    if (postcondition === 'd9_media_store_v1') {
      await this.verifyMediaStoreSchema(connection);
      return;
    }
    if (postcondition === 'd9_media_retention_recovery_v1') {
      await this.verifyMediaRetentionRecoverySchema(connection);
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
      d2_scope_mask_capacity_v1: ['mcp_grants', 'pairing_requests'],
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
      d9_share_analytics_v1: [
        'share_analytics_contexts',
        'share_analytics_context_pages',
        'share_analytics_replays',
        'share_analytics_rolling_admissions',
        'share_analytics_daily_viewers',
        'share_analytics_daily_aggregates',
        'share_analytics_lifetime_aggregates',
        'share_analytics_cleanup_leases',
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

  private async verifyRevisionRetentionBackfill(connection: PoolConnection): Promise<void> {
    const [rows] = await connection.query<
      Array<RowDataPacket & { missingCatalog: string; missingPayload: string }>
    >(
      `SELECT
         CAST(COALESCE(SUM(c.revision_pk IS NULL), 0) AS CHAR) AS missingCatalog,
         CAST(COALESCE(SUM(p.revision_pk IS NULL), 0) AS CHAR) AS missingPayload
       FROM board_revisions r
       LEFT JOIN board_revision_catalog c
         ON c.board_pk = r.board_pk AND c.revision_pk = r.revision_pk
       LEFT JOIN board_revision_payloads p ON p.revision_pk = r.revision_pk
       WHERE r.scene_payload IS NOT NULL`,
    );
    const row = rows[0];
    if (rows.length !== 1 || row?.missingCatalog !== '0' || row.missingPayload !== '0') {
      throw new Error('revision retention backfill is incomplete');
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
           'chk_revisions_checkpoint',
           'chk_revisions_retained_checkpoint'
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

  private async verifyRevisionMediaRefsSchema(connection: PoolConnection): Promise<void> {
    const [columns] = await connection.query<
      Array<
        RowDataPacket & {
          columnName: string;
          columnType: string;
          isNullable: string;
          ordinalPosition: number;
        }
      >
    >(
      `SELECT column_name AS columnName, column_type AS columnType,
              is_nullable AS isNullable, ordinal_position AS ordinalPosition
       FROM information_schema.columns
       WHERE table_schema = DATABASE()
         AND table_name = 'board_revision_media_refs'
       ORDER BY ordinal_position`,
    );
    const expectedColumns = [
      ['board_pk', 'bigint unsigned', 'NO', 1],
      ['revision_pk', 'bigint unsigned', 'NO', 2],
      ['media_id', 'varbinary(128)', 'NO', 3],
      ['first_page_id', 'varbinary(128)', 'NO', 4],
      ['ordinal', 'int unsigned', 'NO', 5],
    ] as const;
    assertExactProjection(
      'revision media refs column',
      expectedColumns,
      columns.map((column) => [
        column.columnName,
        column.columnType.toLowerCase(),
        column.isNullable,
        Number(column.ordinalPosition),
      ]),
    );
    const [indexes] = await connection.query<
      Array<RowDataPacket & { indexName: string; nonUnique: number; columns: string }>
    >(
      `SELECT index_name AS indexName, non_unique AS nonUnique,
              GROUP_CONCAT(column_name ORDER BY seq_in_index SEPARATOR ',') AS columns
       FROM information_schema.statistics
       WHERE table_schema = DATABASE()
         AND table_name = 'board_revision_media_refs'
       GROUP BY index_name, non_unique`,
    );
    const actualIndexes = new Map(
      indexes.map((index) => [index.indexName, `${index.nonUnique}:${index.columns}`]),
    );
    const expectedIndexes = new Map([
      ['PRIMARY', '0:revision_pk,media_id'],
      ['uq_revision_media_ref_order', '0:revision_pk,ordinal'],
      ['ix_revision_media_ref_lookup', '1:board_pk,media_id,revision_pk'],
      ['fk_revision_media_refs_revision', '1:board_pk,revision_pk'],
    ]);
    if (
      actualIndexes.size !== expectedIndexes.size ||
      [...expectedIndexes].some(([name, value]) => actualIndexes.get(name) !== value)
    ) {
      throw new MigrationStateError('revision media refs index projection mismatch');
    }
    const [foreignKeys] = await connection.query<
      Array<
        RowDataPacket & {
          constraintName: string;
          columns: string;
          referencedTableName: string;
          referencedColumns: string;
          deleteRule: string;
        }
      >
    >(
      `SELECT kcu.constraint_name AS constraintName,
              GROUP_CONCAT(kcu.column_name ORDER BY kcu.ordinal_position SEPARATOR ',') AS columns,
              kcu.referenced_table_name AS referencedTableName,
              GROUP_CONCAT(
                kcu.referenced_column_name ORDER BY kcu.ordinal_position SEPARATOR ','
              ) AS referencedColumns,
              MAX(rc.delete_rule) AS deleteRule
       FROM information_schema.key_column_usage kcu
       JOIN information_schema.referential_constraints rc
         ON rc.constraint_schema = kcu.constraint_schema
           AND rc.constraint_name = kcu.constraint_name
       WHERE kcu.table_schema = DATABASE()
         AND kcu.table_name = 'board_revision_media_refs'
         AND kcu.referenced_table_name IS NOT NULL
       GROUP BY kcu.constraint_name, kcu.referenced_table_name`,
    );
    const foreignKey = foreignKeys[0];
    if (
      foreignKeys.length !== 1 ||
      foreignKey === undefined ||
      foreignKey.constraintName !== 'fk_revision_media_refs_revision' ||
      foreignKey.columns !== 'board_pk,revision_pk' ||
      foreignKey.referencedTableName !== 'board_revisions' ||
      foreignKey.referencedColumns !== 'board_pk,revision_pk' ||
      foreignKey.deleteRule !== 'RESTRICT'
    ) {
      throw new MigrationStateError('revision media refs foreign key projection mismatch');
    }
  }

  private async verifyMediaStoreSchema(connection: PoolConnection): Promise<void> {
    const tableNames = [
      'media_objects',
      'board_media',
      'board_media_quota',
      'media_ingest_idempotency',
    ] as const;
    const placeholders = tableNames.map(() => '?').join(', ');
    const [tables] = await connection.query<Array<RowDataPacket & { tableName: string }>>(
      `SELECT table_name AS tableName
       FROM information_schema.tables
       WHERE table_schema = DATABASE() AND table_name IN (${placeholders})`,
      tableNames,
    );
    if (
      tables.length !== tableNames.length ||
      new Set(tables.map(({ tableName }) => tableName)).size !== tableNames.length
    )
      throw new MigrationStateError('media store table projection mismatch');

    const [columns] = await connection.query<
      Array<
        RowDataPacket & {
          tableName: string;
          columnName: string;
          ordinalPosition: number;
          columnType: string;
          isNullable: string;
        }
      >
    >(
      `SELECT table_name AS tableName, column_name AS columnName,
              ordinal_position AS ordinalPosition, column_type AS columnType,
              is_nullable AS isNullable
       FROM information_schema.columns
       WHERE table_schema = DATABASE() AND table_name IN (${placeholders})
       ORDER BY table_name, ordinal_position`,
      tableNames,
    );
    const expectedColumns = [
      ['board_media', 'board_media_pk', 1, 'bigint unsigned', 'NO'],
      ['board_media', 'board_pk', 2, 'bigint unsigned', 'NO'],
      ['board_media', 'media_pk', 3, 'bigint unsigned', 'NO'],
      ['board_media', 'media_id', 4, 'varbinary(128)', 'NO'],
      ['board_media', 'status', 5, "enum('active','quarantined','released')", 'NO'],
      ['board_media', 'lease_expires_at', 6, 'datetime(3)', 'NO'],
      ['board_media', 'version', 7, 'bigint unsigned', 'NO'],
      ['board_media', 'created_at', 8, 'datetime(3)', 'NO'],
      ['board_media', 'updated_at', 9, 'datetime(3)', 'NO'],
      ['board_media_quota', 'board_pk', 1, 'bigint unsigned', 'NO'],
      ['board_media_quota', 'used_bytes', 2, 'bigint unsigned', 'NO'],
      ['board_media_quota', 'version', 3, 'bigint unsigned', 'NO'],
      ['board_media_quota', 'updated_at', 4, 'datetime(3)', 'NO'],
      ['media_ingest_idempotency', 'account_pk', 1, 'bigint unsigned', 'NO'],
      ['media_ingest_idempotency', 'board_pk', 2, 'bigint unsigned', 'NO'],
      ['media_ingest_idempotency', 'idempotency_key', 3, 'varbinary(128)', 'NO'],
      ['media_ingest_idempotency', 'fingerprint_sha256', 4, 'binary(32)', 'NO'],
      ['media_ingest_idempotency', 'result_kind', 5, "enum('active','expired')", 'NO'],
      ['media_ingest_idempotency', 'result_json', 6, 'json', 'NO'],
      ['media_ingest_idempotency', 'result_sha256', 7, 'binary(32)', 'NO'],
      ['media_ingest_idempotency', 'board_media_pk', 8, 'bigint unsigned', 'YES'],
      ['media_ingest_idempotency', 'recovery_id', 9, 'varbinary(128)', 'YES'],
      ['media_ingest_idempotency', 'created_at', 10, 'datetime(3)', 'NO'],
      ['media_ingest_idempotency', 'updated_at', 11, 'datetime(3)', 'NO'],
      ['media_objects', 'media_pk', 1, 'bigint unsigned', 'NO'],
      ['media_objects', 'sha256', 2, 'binary(32)', 'NO'],
      ['media_objects', 'bytes', 3, 'longblob', 'NO'],
      ['media_objects', 'mime', 4, "enum('image/png','image/jpeg','image/webp')", 'NO'],
      ['media_objects', 'width', 5, 'int unsigned', 'NO'],
      ['media_objects', 'height', 6, 'int unsigned', 'NO'],
      ['media_objects', 'byte_length', 7, 'int unsigned', 'NO'],
      ['media_objects', 'state', 8, "enum('active','quarantined')", 'NO'],
      ['media_objects', 'version', 9, 'bigint unsigned', 'NO'],
      ['media_objects', 'created_at', 10, 'datetime(3)', 'NO'],
      ['media_objects', 'updated_at', 11, 'datetime(3)', 'NO'],
    ] as const;
    assertExactProjection(
      'media store column',
      expectedColumns,
      columns.map((column) => [
        column.tableName,
        column.columnName,
        Number(column.ordinalPosition),
        column.columnType.toLowerCase(),
        column.isNullable,
      ]),
    );

    const [indexes] = await connection.query<
      Array<
        RowDataPacket & {
          tableName: string;
          indexName: string;
          nonUnique: number;
          columns: string;
        }
      >
    >(
      `SELECT table_name AS tableName, index_name AS indexName, non_unique AS nonUnique,
              GROUP_CONCAT(column_name ORDER BY seq_in_index SEPARATOR ',') AS columns
       FROM information_schema.statistics
       WHERE table_schema = DATABASE() AND table_name IN (${placeholders})
       GROUP BY table_name, index_name, non_unique`,
      tableNames,
    );
    const actualIndexes = new Map(
      indexes.map((index) => [
        `${index.tableName}:${index.indexName}`,
        `${index.nonUnique}:${index.columns}`,
      ]),
    );
    const expectedIndexes = new Map([
      ['media_objects:PRIMARY', '0:media_pk'],
      ['media_objects:uq_media_objects_sha256', '0:sha256'],
      ['board_media:PRIMARY', '0:board_media_pk'],
      ['board_media:uq_board_media_public_id', '0:media_id'],
      ['board_media:uq_board_media_object', '0:board_pk,media_pk'],
      ['board_media:ix_board_media_lease', '1:board_pk,status,lease_expires_at'],
      ['board_media:ix_board_media_object_status', '1:media_pk,status'],
      ['board_media_quota:PRIMARY', '0:board_pk'],
      ['media_ingest_idempotency:PRIMARY', '0:account_pk,board_pk,idempotency_key'],
      ['media_ingest_idempotency:ix_media_ingest_ownership', '1:board_media_pk,result_kind'],
    ]);
    if ([...expectedIndexes].some(([name, value]) => actualIndexes.get(name) !== value))
      throw new MigrationStateError('media store index projection mismatch');

    const [foreignKeys] = await connection.query<
      Array<
        RowDataPacket & {
          constraintName: string;
          deleteRule: string;
          updateRule: string;
        }
      >
    >(
      `SELECT rc.constraint_name AS constraintName, rc.delete_rule AS deleteRule,
              rc.update_rule AS updateRule
       FROM information_schema.referential_constraints rc
       WHERE rc.constraint_schema = DATABASE()
         AND rc.table_name IN (${placeholders})`,
      tableNames,
    );
    const expectedForeignKeys = new Set([
      'fk_board_media_board',
      'fk_board_media_object',
      'fk_board_media_quota_board',
      'fk_media_ingest_account',
      'fk_media_ingest_board',
      'fk_media_ingest_ownership',
    ]);
    if (
      foreignKeys.length !== expectedForeignKeys.size ||
      foreignKeys.some(
        (row) =>
          !expectedForeignKeys.has(row.constraintName) ||
          row.deleteRule !== 'RESTRICT' ||
          row.updateRule !== 'RESTRICT',
      )
    )
      throw new MigrationStateError('media store foreign-key projection mismatch');

    const [checks] = await connection.query<Array<RowDataPacket & { constraintName: string }>>(
      `SELECT tc.constraint_name AS constraintName
       FROM information_schema.table_constraints tc
       WHERE tc.table_schema = DATABASE()
         AND tc.table_name IN (${placeholders})
         AND tc.constraint_type = 'CHECK'`,
      tableNames,
    );
    const expectedChecks = new Set([
      'chk_media_objects_dimensions',
      'chk_media_objects_byte_length',
      'chk_media_objects_octets',
      'chk_media_objects_version',
      'chk_board_media_id',
      'chk_board_media_version',
      'chk_board_media_quota_used',
      'chk_board_media_quota_version',
      'chk_media_ingest_key',
      'chk_media_ingest_recovery',
    ]);
    if (
      checks.length !== expectedChecks.size ||
      checks.some(({ constraintName }) => !expectedChecks.has(constraintName))
    )
      throw new MigrationStateError('media store check projection mismatch');
  }

  private async verifyMediaRetentionRecoverySchema(connection: PoolConnection): Promise<void> {
    const tableNames = [
      'media_cleanup_runs',
      'media_cleanup_items',
      'media_backup_certificates',
      'media_backup_certificate_objects',
    ] as const;
    const placeholders = tableNames.map(() => '?').join(', ');
    const [tables] = await connection.query<Array<RowDataPacket & { tableName: string }>>(
      `SELECT table_name AS tableName
       FROM information_schema.tables
       WHERE table_schema = DATABASE() AND table_name IN (${placeholders})`,
      tableNames,
    );
    if (
      tables.length !== tableNames.length ||
      new Set(tables.map(({ tableName }) => tableName)).size !== tableNames.length
    )
      throw new MigrationStateError('media retention table projection mismatch');

    const [columns] = await connection.query<
      Array<RowDataPacket & { tableName: string; columnName: string }>
    >(
      `SELECT table_name AS tableName, column_name AS columnName
       FROM information_schema.columns
       WHERE table_schema = DATABASE() AND table_name IN (${placeholders})`,
      tableNames,
    );
    const requiredColumns = new Set([
      'media_cleanup_runs:run_id',
      'media_cleanup_runs:fence',
      'media_cleanup_runs:lease_expires_at',
      'media_cleanup_items:phase',
      'media_cleanup_items:delete_after',
      'media_cleanup_items:completion_evidence_sha256',
      'media_backup_certificates:media_manifest_sha256',
      'media_backup_certificates:signature',
      'media_backup_certificate_objects:object_version',
      'media_backup_certificate_objects:sha256',
      'media_backup_certificate_objects:byte_length',
    ]);
    const actualColumns = new Set(
      columns.map(({ tableName, columnName }) => `${tableName}:${columnName}`),
    );
    if ([...requiredColumns].some((column) => !actualColumns.has(column)))
      throw new MigrationStateError('media retention column projection mismatch');

    const [indexes] = await connection.query<
      Array<RowDataPacket & { tableName: string; indexName: string }>
    >(
      `SELECT DISTINCT table_name AS tableName, index_name AS indexName
       FROM information_schema.statistics
       WHERE table_schema = DATABASE() AND table_name IN (${placeholders})`,
      tableNames,
    );
    const requiredIndexes = new Set([
      'media_cleanup_runs:PRIMARY',
      'media_cleanup_runs:ix_media_cleanup_runs_lease',
      'media_cleanup_items:PRIMARY',
      'media_cleanup_items:uq_media_cleanup_item_ownership',
      'media_cleanup_items:ix_media_cleanup_items_phase',
      'media_cleanup_items:ix_media_cleanup_items_object',
      'media_backup_certificates:PRIMARY',
      'media_backup_certificates:ix_media_backup_certificates_expiry',
      'media_backup_certificate_objects:PRIMARY',
      'media_backup_certificate_objects:ix_media_backup_certificate_objects_media',
    ]);
    const actualIndexes = new Set(
      indexes.map(({ tableName, indexName }) => `${tableName}:${indexName}`),
    );
    if ([...requiredIndexes].some((index) => !actualIndexes.has(index)))
      throw new MigrationStateError('media retention index projection mismatch');

    const [foreignKeys] = await connection.query<
      Array<RowDataPacket & { constraintName: string; deleteRule: string; updateRule: string }>
    >(
      `SELECT constraint_name AS constraintName, delete_rule AS deleteRule,
              update_rule AS updateRule
       FROM information_schema.referential_constraints
       WHERE constraint_schema = DATABASE() AND table_name IN (${placeholders})`,
      tableNames,
    );
    const expectedForeignKeys = new Set([
      'fk_media_cleanup_items_run',
      'fk_media_cleanup_items_board',
      'fk_media_backup_certificate_objects_certificate',
    ]);
    if (
      foreignKeys.length !== expectedForeignKeys.size ||
      foreignKeys.some(
        ({ constraintName, deleteRule, updateRule }) =>
          !expectedForeignKeys.has(constraintName) ||
          deleteRule !== 'RESTRICT' ||
          updateRule !== 'RESTRICT',
      )
    )
      throw new MigrationStateError('media retention foreign-key projection mismatch');

    const [checks] = await connection.query<Array<RowDataPacket & { constraintName: string }>>(
      `SELECT constraint_name AS constraintName
       FROM information_schema.table_constraints
       WHERE table_schema = DATABASE()
         AND table_name IN (${placeholders})
         AND constraint_type = 'CHECK'`,
      tableNames,
    );
    const requiredChecks = new Set([
      'chk_media_cleanup_runs_fence',
      'chk_media_cleanup_runs_attempts',
      'chk_media_cleanup_items_deadline',
      'chk_media_cleanup_items_backup',
      'chk_media_backup_certificate_outcomes',
      'chk_media_backup_certificate_object_bytes',
    ]);
    if (
      checks.length < requiredChecks.size ||
      [...requiredChecks].some(
        (name) => !checks.some(({ constraintName }) => constraintName === name),
      )
    )
      throw new MigrationStateError('media retention check projection mismatch');
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
    const [rawTableRows] = await connection.query<
      Array<
        RowDataPacket &
          Omit<RevisionRetentionTableProjection, 'engine'> & {
            tableEngine: string | null;
          }
      >
    >(
      `SELECT
         table_name AS tableName,
         table_type AS tableType,
         engine AS tableEngine,
         table_collation AS tableCollation
       FROM information_schema.tables
       WHERE table_schema = DATABASE()
         AND table_name IN (${placeholders})`,
      RETENTION_TABLES,
    );
    const tableRows: RevisionRetentionTableProjection[] = rawTableRows.map((row) => ({
      tableName: row.tableName,
      tableType: row.tableType,
      engine: row.tableEngine,
      tableCollation: row.tableCollation,
    }));
    const [rawColumnRows] = await connection.query<
      Array<
        RowDataPacket &
          Omit<RevisionRetentionColumnProjection, 'extra'> & {
            columnExtra: string;
          }
      >
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
         extra AS columnExtra
       FROM information_schema.columns
       WHERE table_schema = DATABASE()
         AND table_name IN (${placeholders})`,
      RETENTION_TABLES,
    );
    const columnRows: RevisionRetentionColumnProjection[] = rawColumnRows.map((row) => ({
      tableName: row.tableName,
      columnName: row.columnName,
      ordinalPosition: row.ordinalPosition,
      columnType: row.columnType,
      characterSetName: row.characterSetName,
      collationName: row.collationName,
      isNullable: row.isNullable,
      columnDefault: row.columnDefault,
      extra: row.columnExtra,
    }));
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
