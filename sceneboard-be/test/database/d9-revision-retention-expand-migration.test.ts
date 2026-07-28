import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import { MIGRATION_REGISTRY } from '../../src/database/migrations/registry.js';
import {
  MigrationStateError,
  assessRevisionRetentionExpand,
  type RevisionRetentionCheckProjection,
  type RevisionRetentionColumnProjection,
  type RevisionRetentionForeignKeyProjection,
  type RevisionRetentionIndexProjection,
  type RevisionRetentionTableProjection,
} from '../../src/database/migrations/runner.js';
import { splitSqlStatements } from '../../src/database/migrations/sql-splitter.js';

interface Fixture {
  schemaVersion: number;
  migration: string;
  reversible: boolean;
  tables: string[];
  columns: Array<[string, string, number, string, string | null, string | null, string]>;
  indexes: Array<[string, string, number, number, string]>;
  foreignKeys: Array<[string, string, string, string, string, string, number]>;
  checks: Array<[string, string, string]>;
}

const readFixture = async (): Promise<Fixture> =>
  JSON.parse(
    await readFile(
      new URL('../contracts/schema-projections/d9-revision-retention-expand.json', import.meta.url),
      'utf8',
    ),
  ) as Fixture;

const toColumns = (fixture: Fixture): RevisionRetentionColumnProjection[] =>
  fixture.columns.map(
    ([
      tableName,
      columnName,
      ordinalPosition,
      columnType,
      characterSetName,
      collationName,
      isNullable,
    ]) => ({
      tableName,
      columnName,
      ordinalPosition,
      columnType,
      characterSetName,
      collationName,
      isNullable,
      columnDefault: null,
      extra: '',
    }),
  );

const toIndexes = (fixture: Fixture): RevisionRetentionIndexProjection[] =>
  fixture.indexes.map(([tableName, indexName, nonUnique, sequence, columnName]) => ({
    tableName,
    indexName,
    nonUnique,
    sequence,
    columnName,
  }));

const toForeignKeys = (fixture: Fixture): RevisionRetentionForeignKeyProjection[] =>
  fixture.foreignKeys.map(
    ([
      tableName,
      constraintName,
      columnName,
      referencedTableName,
      referencedColumnName,
      deleteRule,
      sequence,
    ]) => ({
      tableName,
      constraintName,
      columnName,
      referencedTableName,
      referencedColumnName,
      deleteRule,
      sequence,
    }),
  );

const toChecks = (fixture: Fixture): RevisionRetentionCheckProjection[] =>
  fixture.checks.map(([tableName, constraintName, checkClause]) => ({
    tableName,
    constraintName,
    checkClause,
  }));

const toTables = (fixture: Fixture): RevisionRetentionTableProjection[] =>
  fixture.tables.map((tableName) => ({
    tableName,
    tableType: 'BASE TABLE',
    engine: 'InnoDB',
    tableCollation: 'utf8mb4_0900_ai_ci',
  }));

test('registers the exact forward-only retention expand migration after checkpoint widening', async () => {
  const entry = MIGRATION_REGISTRY.at(-4);
  assert.deepEqual(entry, {
    version: '014_d9_revision_retention_expand',
    upAsset: '014_d9_revision_retention_expand.up.sql',
    reversible: false,
    downAsset: null,
    postcondition: 'd9_revision_retention_expand_v1',
  });
  assert.equal(MIGRATION_REGISTRY.at(-5)?.version, '013_d9_v2_checkpoint_capacity');

  const fixture = await readFixture();
  assert.deepEqual(
    {
      schemaVersion: fixture.schemaVersion,
      migration: fixture.migration,
      reversible: fixture.reversible,
    },
    {
      schemaVersion: 1,
      migration: '014_d9_revision_retention_expand',
      reversible: false,
    },
  );
});

test('certifies exact columns, indexes, restrictive same-revision FKs, and closed CHECK names', async () => {
  const fixture = await readFixture();
  const columns = toColumns(fixture);
  const indexes = toIndexes(fixture);
  const foreignKeys = toForeignKeys(fixture);
  const checks = toChecks(fixture);
  const tables = toTables(fixture);
  assert.doesNotThrow(() =>
    assessRevisionRetentionExpand(columns, indexes, foreignKeys, checks, tables),
  );
  assert.throws(
    () =>
      assessRevisionRetentionExpand(
        columns.map((column) =>
          column.columnName === 'schema_version'
            ? { ...column, collationName: 'ascii_general_ci' }
            : column,
        ),
        indexes,
        foreignKeys,
        checks,
        tables,
      ),
    MigrationStateError,
  );
  assert.throws(
    () =>
      assessRevisionRetentionExpand(
        columns,
        indexes.filter((index) => index.indexName !== 'ix_revision_holds_active'),
        foreignKeys,
        checks,
        tables,
      ),
    MigrationStateError,
  );
  assert.throws(
    () =>
      assessRevisionRetentionExpand(
        columns,
        indexes,
        foreignKeys.map((foreignKey) =>
          foreignKey.constraintName === 'fk_revision_catalog_revision'
            ? { ...foreignKey, deleteRule: 'CASCADE' }
            : foreignKey,
        ),
        checks,
        tables,
      ),
    MigrationStateError,
  );
  assert.throws(
    () =>
      assessRevisionRetentionExpand(
        columns,
        indexes,
        foreignKeys,
        checks.map((check) =>
          check.constraintName === 'chk_revision_payloads_checkpoint'
            ? { ...check, checkClause: check.checkClause.replace("codec = 'B' AND ", '') }
            : check,
        ),
        tables,
      ),
    MigrationStateError,
  );
  assert.throws(
    () =>
      assessRevisionRetentionExpand(
        columns,
        indexes,
        foreignKeys,
        checks,
        tables.map((table) =>
          table.tableName === 'board_revision_payloads' ? { ...table, engine: 'MyISAM' } : table,
        ),
      ),
    MigrationStateError,
  );
});

test('uses four restart-safe DDL statements and converges after interruption at every boundary', async () => {
  const fixture = await readFixture();
  const source = await readFile(
    new URL(
      '../../src/database/migrations/sql/014_d9_revision_retention_expand.up.sql',
      import.meta.url,
    ),
    'utf8',
  );
  const statements = splitSqlStatements(source);
  assert.equal(statements.length, fixture.tables.length);
  for (const [index, statement] of statements.entries()) {
    assert.match(statement, /^CREATE TABLE IF NOT EXISTS /u);
    assert.match(
      statement,
      new RegExp(`CREATE TABLE IF NOT EXISTS ${fixture.tables[index]} \\(`, 'u'),
    );
  }

  for (let interruption = 0; interruption <= statements.length; interruption += 1) {
    const installed = new Set(
      statements
        .slice(0, interruption)
        .map((statement) => /CREATE TABLE IF NOT EXISTS ([a-z0-9_]+)/u.exec(statement)?.[1]),
    );
    for (const statement of statements) {
      installed.add(/CREATE TABLE IF NOT EXISTS ([a-z0-9_]+)/u.exec(statement)?.[1]);
    }
    assert.deepEqual([...installed].sort(), [...fixture.tables].sort());
  }
});

test('keeps analytics outside the revision FK and hold projection', async () => {
  const fixture = await readFixture();
  const allProjectionNames = JSON.stringify(fixture);
  assert.doesNotMatch(allProjectionNames, /analytics|page_view|event_aggregate/u);
  assert.ok(fixture.tables.every((table) => table.startsWith('board_revision_')));
});
