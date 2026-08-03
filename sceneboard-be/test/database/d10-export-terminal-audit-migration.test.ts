import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  assessExportTerminalAuditPostcondition,
  type ExportTerminalAuditCheckProjection,
  type ExportTerminalAuditColumnProjection,
  type ExportTerminalAuditIndexProjection,
  type ExportTerminalAuditTableProjection,
} from '../../src/database/migrations/postconditions.js';
import { MIGRATION_REGISTRY } from '../../src/database/migrations/registry.js';
import { isRecoverableExportTerminalAuditTableExists } from '../../src/database/migrations/runner.js';
import { splitSqlStatements } from '../../src/database/migrations/sql-splitter.js';

const terminalAuditProjectionV1 = () => ({
  tables: [
    {
      tableName: 'export_terminal_audit_intents',
      tableType: 'BASE TABLE',
      engine: 'InnoDB',
      tableCollation: 'utf8mb4_0900_ai_ci',
    },
  ] as ExportTerminalAuditTableProjection[],
  columns: [
    ['terminal_audit_intent_pk', 1, 'bigint unsigned', null, null, 'NO', null, 'auto_increment'],
    ['correlation_id', 2, 'varchar(64)', 'ascii', 'ascii_bin', 'NO', null, ''],
    ['actor_kind', 3, "enum('user','service')", 'utf8mb4', 'utf8mb4_0900_ai_ci', 'NO', null, ''],
    ['actor_public_id', 4, 'varchar(128)', 'ascii', 'ascii_bin', 'NO', null, ''],
    ['format', 5, "enum('pdf','pptx')", 'utf8mb4', 'utf8mb4_0900_ai_ci', 'NO', null, ''],
    ['revision_number', 6, 'bigint unsigned', null, null, 'NO', null, ''],
    [
      'outcome',
      7,
      "enum('pending','completed','failed')",
      'utf8mb4',
      'utf8mb4_0900_ai_ci',
      'NO',
      null,
      '',
    ],
    ['completed_bytes', 8, 'bigint unsigned', null, null, 'YES', null, ''],
    ['failure_reason', 9, 'varchar(64)', 'ascii', 'ascii_bin', 'YES', null, ''],
    ['persisted_at', 10, 'datetime(3)', null, null, 'YES', null, ''],
    [
      'created_at',
      11,
      'datetime(3)',
      null,
      null,
      'NO',
      'CURRENT_TIMESTAMP(3)',
      'DEFAULT_GENERATED',
    ],
  ].map(
    ([
      columnName,
      ordinalPosition,
      columnType,
      characterSetName,
      collationName,
      isNullable,
      columnDefault,
      extra,
    ]) => ({
      columnName,
      ordinalPosition,
      columnType,
      characterSetName,
      collationName,
      isNullable,
      columnDefault,
      extra,
    }),
  ) as ExportTerminalAuditColumnProjection[],
  indexes: [
    ['PRIMARY', 0, 1, 'terminal_audit_intent_pk', 'A'],
    ['ix_export_terminal_audit_recovery', 1, 1, 'outcome', 'A'],
    ['ix_export_terminal_audit_recovery', 1, 2, 'persisted_at', 'A'],
    ['ix_export_terminal_audit_recovery', 1, 3, 'terminal_audit_intent_pk', 'A'],
    ['uq_export_terminal_audit_correlation', 0, 1, 'correlation_id', 'A'],
  ].map(([indexName, nonUnique, sequence, columnName, collation]) => ({
    indexName,
    nonUnique,
    sequence,
    columnName,
    collation,
  })) as ExportTerminalAuditIndexProjection[],
  checks: [
    ['chk_export_terminal_audit_actor', 'CHAR_LENGTH(actor_public_id) BETWEEN 1 AND 128'],
    ['chk_export_terminal_audit_correlation', 'CHAR_LENGTH(correlation_id) BETWEEN 1 AND 64'],
    [
      'chk_export_terminal_audit_payload',
      `(outcome = 'pending' AND completed_bytes IS NULL AND failure_reason IS NULL
        AND persisted_at IS NULL)
       OR (outcome = 'completed' AND completed_bytes BETWEEN 0 AND 9007199254740991
        AND failure_reason IS NULL)
       OR (outcome = 'failed' AND completed_bytes IS NULL AND failure_reason IN (
        'EXPORT_INVALID_REQUEST', 'EXPORT_UNAUTHENTICATED', 'EXPORT_FORBIDDEN', 'EXPORT_NOT_FOUND',
        'EXPORT_REQUIRED_CONTENT_UNSUPPORTED', 'EXPORT_BOUNDS_EXCEEDED', 'EXPORT_RATE_LIMITED',
        'EXPORT_RENDERER_UNAVAILABLE', 'EXPORT_RENDER_TIMEOUT', 'EXPORT_ENCODE_FAILED',
        'EXPORT_INTERNAL_ERROR'))`,
    ],
    ['chk_export_terminal_audit_revision', 'revision_number BETWEEN 1 AND 9007199254740991'],
  ].map(([constraintName, checkClause]) => ({
    constraintName,
    checkClause,
  })) as ExportTerminalAuditCheckProjection[],
});

test('migration 029 creates one forward-only pending-to-final terminal audit intent table', async () => {
  const entry = MIGRATION_REGISTRY.at(-1);
  assert.deepEqual(entry, {
    version: '029_d10_export_terminal_audit',
    upAsset: '029_d10_export_terminal_audit.up.sql',
    reversible: false,
    downAsset: null,
    postcondition: 'd10_export_terminal_audit_v1',
  });
  const source = await readFile(
    new URL(
      '../../src/database/migrations/sql/029_d10_export_terminal_audit.up.sql',
      import.meta.url,
    ),
    'utf8',
  );
  assert.equal(splitSqlStatements(source).length, 1);
  assert.match(source, /CREATE TABLE export_terminal_audit_intents/u);
  assert.match(source, /UNIQUE KEY uq_export_terminal_audit_correlation \(correlation_id\)/u);
  assert.match(
    source,
    /KEY ix_export_terminal_audit_recovery \(outcome, persisted_at, terminal_audit_intent_pk\)/u,
  );
  assert.match(source, /outcome = 'pending'.*persisted_at IS NULL/su);
  assert.match(source, /outcome = 'completed'.*failure_reason IS NULL/su);
  assert.match(source, /outcome = 'failed'.*completed_bytes IS NULL/su);
  assert.doesNotMatch(source, /board_id|revision_id|title|token|authorization/iu);
});

test('migration 029 restart recovery accepts only its exact DDL-before-ledger table-exists window', () => {
  const tableExists = { code: 'ER_TABLE_EXISTS_ERROR', errno: 1050 };
  assert.equal(
    isRecoverableExportTerminalAuditTableExists(
      '029_d10_export_terminal_audit',
      'CREATE TABLE export_terminal_audit_intents (id BIGINT)',
      tableExists,
    ),
    true,
  );
  for (const [version, statement, error] of [
    [
      '029_d10_export_terminal_audit',
      'CREATE TABLE IF NOT EXISTS export_terminal_audit_intents (id BIGINT)',
      tableExists,
    ],
    ['029_d10_export_terminal_audit', 'CREATE TABLE another_table (id BIGINT)', tableExists],
    [
      '028_d10_document_replace_idempotency',
      'CREATE TABLE export_terminal_audit_intents (id BIGINT)',
      tableExists,
    ],
    [
      '029_d10_export_terminal_audit',
      'CREATE TABLE export_terminal_audit_intents (id BIGINT)',
      { code: 'ER_PARSE_ERROR', errno: 1064 },
    ],
  ] as const) {
    assert.equal(isRecoverableExportTerminalAuditTableExists(version, statement, error), false);
  }
});

test('migration 029 postcondition rejects narrowed columns, index drift, and payload-check drift', () => {
  const exact = terminalAuditProjectionV1();
  assert.doesNotThrow(() =>
    assessExportTerminalAuditPostcondition(
      exact.tables,
      exact.columns,
      exact.indexes,
      exact.checks,
    ),
  );
  const narrowed = terminalAuditProjectionV1();
  narrowed.columns[8] = { ...narrowed.columns[8]!, columnType: 'varchar(32)' };
  assert.throws(() =>
    assessExportTerminalAuditPostcondition(
      narrowed.tables,
      narrowed.columns,
      narrowed.indexes,
      narrowed.checks,
    ),
  );
  const indexDrift = terminalAuditProjectionV1();
  indexDrift.indexes = indexDrift.indexes.slice(0, -1);
  assert.throws(() =>
    assessExportTerminalAuditPostcondition(
      indexDrift.tables,
      indexDrift.columns,
      indexDrift.indexes,
      indexDrift.checks,
    ),
  );
  const checkDrift = terminalAuditProjectionV1();
  checkDrift.checks[2] = {
    ...checkDrift.checks[2]!,
    checkClause: "outcome = 'completed' AND completed_bytes >= 0",
  };
  assert.throws(() =>
    assessExportTerminalAuditPostcondition(
      checkDrift.tables,
      checkDrift.columns,
      checkDrift.indexes,
      checkDrift.checks,
    ),
  );
});
