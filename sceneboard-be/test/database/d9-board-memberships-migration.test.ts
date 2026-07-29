import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import { MIGRATION_REGISTRY } from '../../src/database/migrations/registry.js';
import { splitSqlStatements } from '../../src/database/migrations/sql-splitter.js';

const source = async (): Promise<string> =>
  readFile(
    new URL('../../src/database/migrations/sql/016_d9_board_memberships.up.sql', import.meta.url),
    'utf8',
  );

test('registers the forward-additive membership migration after retention runtime', () => {
  const entryIndex = MIGRATION_REGISTRY.findIndex(
    ({ version }) => version === '016_d9_board_memberships',
  );
  assert.deepEqual(MIGRATION_REGISTRY[entryIndex], {
    version: '016_d9_board_memberships',
    upAsset: '016_d9_board_memberships.up.sql',
    reversible: false,
    downAsset: null,
    postcondition: 'd9_board_memberships_v1',
  });
  assert.equal(MIGRATION_REGISTRY[entryIndex - 1]?.version, '015_d9_revision_retention_runtime');
});

test('pins unique membership, active lookup, version, and owner projection constraints', async () => {
  const sql = await source();
  assert.equal(splitSqlStatements(sql).length, 2);
  assert.match(sql, /UNIQUE KEY uq_board_memberships_account \(board_pk, account_pk\)/u);
  assert.match(sql, /KEY ix_board_memberships_active_account \(account_pk, state, board_pk\)/u);
  assert.match(sql, /version BETWEEN 1 AND 9007199254740991/u);
  assert.match(sql, /UNIQUE KEY uq_board_memberships_owner \(board_pk, owner_account_pk\)/u);
  assert.match(sql, /role = 'owner'\s+AND state = 'active'\s+AND owner_account_pk = account_pk/u);
});

test('owner adoption is bounded and idempotent across interrupted restart', async () => {
  const sql = await source();
  assert.match(sql, /CREATE TABLE IF NOT EXISTS board_memberships/u);
  assert.match(sql, /INSERT INTO board_memberships/u);
  assert.match(sql, /FROM boards b/u);
  assert.match(sql, /ON DUPLICATE KEY UPDATE/u);
  assert.match(sql, /version = GREATEST\(board_memberships\.version, VALUES\(version\)\)/u);
  assert.match(
    sql,
    /updated_at = GREATEST\(board_memberships\.updated_at, VALUES\(updated_at\)\)/u,
  );
});
