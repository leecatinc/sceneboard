import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import {
  assessAccountApiKeyPostcondition,
  verifyAccountApiKeyPostcondition,
  type AccountApiKeyCheckProjection,
  type AccountApiKeyColumnProjection,
  type AccountApiKeyForeignKeyProjection,
  type AccountApiKeyIndexProjection,
} from '../../src/database/migrations/postconditions.js';
import { isRecoverableAccountApiKeyTableExists } from '../../src/database/migrations/runner.js';
import { splitSqlStatements } from '../../src/database/migrations/sql-splitter.js';

const columns = [
  ['id', 1, 'bigint unsigned', null, null, 'NO', null, 'auto_increment'],
  ['public_id', 2, 'varchar(128)', 'ascii', 'ascii_bin', 'NO', null, ''],
  ['owner_user_id', 3, 'bigint unsigned', null, null, 'NO', null, ''],
  ['display_name', 4, 'varchar(160)', 'utf8mb4', 'utf8mb4_0900_ai_ci', 'NO', null, ''],
  ['token_version', 5, 'tinyint unsigned', null, null, 'NO', '1', ''],
  ['token_locator', 6, 'binary(16)', null, null, 'NO', null, ''],
  ['token_hash', 7, 'binary(32)', null, null, 'NO', null, ''],
  ['scope_mask', 8, 'bigint unsigned', null, null, 'NO', null, ''],
  ['status', 9, 'tinyint unsigned', null, null, 'NO', '1', ''],
  ['expires_at', 10, 'datetime(3)', null, null, 'NO', null, ''],
  ['created_at', 11, 'datetime(3)', null, null, 'NO', 'CURRENT_TIMESTAMP(3)', 'DEFAULT_GENERATED'],
  ['last_used_at', 12, 'datetime(3)', null, null, 'YES', null, ''],
  ['revoked_at', 13, 'datetime(3)', null, null, 'YES', null, ''],
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
  ]) =>
    ({
      columnName,
      ordinalPosition,
      columnType,
      characterSetName,
      collationName,
      isNullable,
      columnDefault,
      extra,
    }) as AccountApiKeyColumnProjection,
);

const indexes = [
  ['PRIMARY', 0, 1, 'id'],
  ['ix_account_api_key_expiry', 1, 1, 'status'],
  ['ix_account_api_key_expiry', 1, 2, 'expires_at'],
  ['ix_account_api_key_expiry', 1, 3, 'id'],
  ['ix_account_api_key_owner_list', 1, 1, 'owner_user_id'],
  ['ix_account_api_key_owner_list', 1, 2, 'created_at'],
  ['ix_account_api_key_owner_list', 1, 3, 'id'],
  ['ix_account_api_key_owner_list', 1, 4, 'status'],
  ['uq_account_api_key_public_id', 0, 1, 'public_id'],
  ['uq_account_api_key_token_locator', 0, 1, 'token_locator'],
].map(
  ([indexName, nonUnique, sequence, columnName]) =>
    ({
      indexName,
      nonUnique,
      sequence,
      columnName,
      collation:
        indexName === 'ix_account_api_key_owner_list' &&
        (columnName === 'created_at' || columnName === 'id')
          ? 'D'
          : 'A',
    }) as AccountApiKeyIndexProjection,
);

const foreignKeys = [
  {
    constraintName: 'fk_account_api_key_owner',
    columnName: 'owner_user_id',
    referencedTableName: 'users',
    referencedColumnName: 'id',
    deleteRule: 'RESTRICT',
    updateRule: 'RESTRICT',
  } as AccountApiKeyForeignKeyProjection,
];

const checks = [
  [
    'chk_account_api_key_public_id',
    "regexp_like(`public_id`,_utf8mb4\\'^[A-Za-z0-9_-]{1,128}$\\',_utf8mb4\\'c\\')",
  ],
  [
    'chk_account_api_key_display_name',
    'display_name = TRIM(display_name) AND CHAR_LENGTH(display_name) BETWEEN 1 AND 80',
  ],
  ['chk_account_api_key_token_version', 'token_version = 1'],
  ['chk_account_api_key_scope_mask', 'scope_mask BETWEEN 1 AND 63'],
  ['chk_account_api_key_status', 'status IN (1, 2)'],
  [
    'chk_account_api_key_times',
    'created_at < expires_at AND (last_used_at IS NULL OR last_used_at >= created_at) AND (revoked_at IS NULL OR revoked_at >= created_at)',
  ],
  [
    'chk_account_api_key_terminal',
    '(status = 1 AND revoked_at IS NULL) OR (status = 2 AND revoked_at IS NOT NULL)',
  ],
].map(
  ([constraintName, checkClause]) =>
    ({ constraintName, checkClause }) as AccountApiKeyCheckProjection,
);

test('creates the exact account API-key table without plaintext credentials', async () => {
  const source = await readFile(
    new URL('../../src/database/migrations/sql/025_d10_account_api_keys.up.sql', import.meta.url),
    'utf8',
  );
  assert.equal(splitSqlStatements(source).length, 1);
  assert.match(source, /CREATE TABLE account_api_keys/u);
  assert.match(source, /token_locator BINARY\(16\) NOT NULL/u);
  assert.match(source, /token_hash BINARY\(32\) NOT NULL/u);
  assert.doesNotMatch(source, /plaintext|raw_token|access_token/u);
  assert.match(source, /ON DELETE RESTRICT ON UPDATE RESTRICT/u);
});

test('retries an unrecorded 025 table and certifies only its exact shape', async () => {
  const source = await readFile(
    new URL('../../src/database/migrations/sql/025_d10_account_api_keys.up.sql', import.meta.url),
    'utf8',
  );
  const [createStatement] = splitSqlStatements(source);
  const tableExists = { code: 'ER_TABLE_EXISTS_ERROR', errno: 1050 };
  assert.equal(
    isRecoverableAccountApiKeyTableExists(
      '025_d10_account_api_keys',
      createStatement ?? '',
      tableExists,
    ),
    true,
  );
  assert.equal(
    isRecoverableAccountApiKeyTableExists(
      '024_d9_share_analytics',
      createStatement ?? '',
      tableExists,
    ),
    false,
  );
  assert.equal(
    isRecoverableAccountApiKeyTableExists(
      '025_d10_account_api_keys',
      'CREATE TABLE unrelated_table (id BIGINT)',
      tableExists,
    ),
    false,
  );
  assert.equal(
    isRecoverableAccountApiKeyTableExists('025_d10_account_api_keys', createStatement ?? '', {
      code: 'ER_PARSE_ERROR',
      errno: 1064,
    }),
    false,
  );
  assert.doesNotThrow(() =>
    assessAccountApiKeyPostcondition(columns, indexes, foreignKeys, checks),
  );

  const driftedColumns = columns.map((column) => ({ ...column }));
  driftedColumns[6] = { ...driftedColumns[6]!, columnType: 'varbinary(32)' };
  assert.throws(
    () => assessAccountApiKeyPostcondition(driftedColumns, indexes, foreignKeys, checks),
    /column projection mismatch/u,
  );
});

test('accepts only the exact account API-key postcondition projection', () => {
  assert.doesNotThrow(() =>
    assessAccountApiKeyPostcondition(columns, indexes, foreignKeys, checks),
  );
  assert.doesNotThrow(() =>
    assessAccountApiKeyPostcondition(
      columns,
      indexes,
      foreignKeys,
      checks.map((check) => ({ ...check, checkClause: `(( ${check.checkClause} ))` })),
    ),
  );
  const cosmeticPredicateWrappers = checks.map((check) =>
    check.constraintName === 'chk_account_api_key_display_name'
      ? {
          ...check,
          checkClause:
            '(((display_name = TRIM(display_name)))) AND ((CHAR_LENGTH(display_name) BETWEEN 1 AND 80))',
        }
      : check.constraintName === 'chk_account_api_key_times'
        ? {
            ...check,
            checkClause:
              '(created_at < expires_at) AND (((last_used_at IS NULL OR last_used_at >= created_at))) AND ((revoked_at IS NULL OR revoked_at >= created_at))',
          }
        : { ...check },
  );
  assert.doesNotThrow(() =>
    assessAccountApiKeyPostcondition(columns, indexes, foreignKeys, cosmeticPredicateWrappers),
  );
  const drifted = columns.map((column) => ({ ...column }));
  drifted[6] = { ...drifted[6]!, columnType: 'varbinary(32)' };
  assert.throws(
    () => assessAccountApiKeyPostcondition(drifted, indexes, foreignKeys, checks),
    /column projection mismatch/u,
  );
  const ascendingOwnerList = indexes.map((index) => ({ ...index }));
  ascendingOwnerList[5] = { ...ascendingOwnerList[5]!, collation: 'A' };
  assert.throws(
    () => assessAccountApiKeyPostcondition(columns, ascendingOwnerList, foreignKeys, checks),
    /index projection mismatch/u,
  );
  assert.throws(
    () => assessAccountApiKeyPostcondition(columns, indexes, foreignKeys, checks.slice(1)),
    /check projection mismatch/u,
  );
});

test('rejects semantically drifted account API-key check constraints', () => {
  const driftCases = [
    {
      name: 'chk_account_api_key_scope_mask',
      clause: 'scope_mask BETWEEN 1 AND 63 OR TRUE',
    },
    {
      name: 'chk_account_api_key_scope_mask',
      clause: 'scope_mask BETWEEN 0 AND 63',
    },
    {
      name: 'chk_account_api_key_times',
      clause:
        '(created_at < expires_at AND (last_used_at IS NULL OR last_used_at >= created_at) AND (revoked_at IS NULL OR revoked_at >= created_at)) OR TRUE',
    },
    {
      name: 'chk_account_api_key_terminal',
      clause:
        '((status = 1 AND revoked_at IS NULL) OR (status = 2 AND revoked_at IS NOT NULL)) OR TRUE',
    },
    {
      name: 'chk_account_api_key_times',
      clause:
        '(created_at < expires_at AND last_used_at IS NULL) OR (last_used_at >= created_at AND (revoked_at IS NULL OR revoked_at >= created_at))',
    },
    {
      name: 'chk_account_api_key_public_id',
      clause: "REGEXP_LIKE(public_id, '^[a-z0-9_-]{1,128}$', 'c')",
    },
    {
      name: 'chk_account_api_key_public_id',
      clause: "REGEXP_LIKE(public_id, '^[A-Z0-9_-]{1,128}$', 'c')",
    },
  ] as const;
  for (const driftCase of driftCases) {
    const driftedChecks = checks.map((check) =>
      check.constraintName === driftCase.name
        ? { ...check, checkClause: driftCase.clause }
        : { ...check },
    );
    assert.throws(
      () => assessAccountApiKeyPostcondition(columns, indexes, foreignKeys, driftedChecks),
      new RegExp(`check clause mismatch: ${driftCase.name}`, 'u'),
    );
  }
});

test('aliases mysql index direction into the query-facing postcondition projection', async () => {
  const queries: string[] = [];
  const connection = {
    async query(sql: string) {
      queries.push(sql);
      if (sql.includes('information_schema.columns')) return [columns, []];
      if (sql.includes('information_schema.statistics')) {
        const aliasesDirection = /collation\s+AS\s+collation/iu.test(sql);
        return [
          indexes.map((index) =>
            aliasesDirection
              ? { ...index }
              : Object.assign(
                  Object.fromEntries(
                    Object.entries(index).filter(([name]) => name !== 'collation'),
                  ),
                  { COLLATION: index.collation },
                ),
          ),
          [],
        ];
      }
      if (sql.includes('information_schema.key_column_usage')) return [foreignKeys, []];
      if (sql.includes('information_schema.table_constraints')) return [checks, []];
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  await assert.doesNotReject(verifyAccountApiKeyPostcondition(connection as never));
  const indexQuery = queries.find((query) => query.includes('information_schema.statistics'));
  assert.match(indexQuery ?? '', /collation\s+AS\s+collation/iu);
  assert.deepEqual(
    indexes
      .filter((index) => index.indexName === 'ix_account_api_key_owner_list')
      .map((index) => [index.columnName, index.collation]),
    [
      ['owner_user_id', 'A'],
      ['created_at', 'D'],
      ['id', 'D'],
      ['status', 'A'],
    ],
  );
});
