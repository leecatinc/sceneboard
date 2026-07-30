import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import {
  assessAccountApiKeyPostcondition,
  type AccountApiKeyCheckProjection,
  type AccountApiKeyColumnProjection,
  type AccountApiKeyForeignKeyProjection,
  type AccountApiKeyIndexProjection,
} from '../../src/database/migrations/postconditions.js';
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
      collation: 'A',
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

test('creates the exact account API-key table without a plaintext credential column', async () => {
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

test('accepts only the exact account API-key postcondition projection', () => {
  assert.doesNotThrow(() =>
    assessAccountApiKeyPostcondition(columns, indexes, foreignKeys, checks),
  );
  const drifted = columns.map((column) => ({ ...column }));
  drifted[6] = { ...drifted[6]!, columnType: 'varbinary(32)' };
  assert.throws(
    () => assessAccountApiKeyPostcondition(drifted, indexes, foreignKeys, checks),
    /column projection mismatch/u,
  );
  assert.throws(
    () => assessAccountApiKeyPostcondition(columns, indexes, foreignKeys, checks.slice(1)),
    /check projection mismatch/u,
  );
});
