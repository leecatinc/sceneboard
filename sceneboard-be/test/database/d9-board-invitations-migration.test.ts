import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import { MIGRATION_REGISTRY } from '../../src/database/migrations/registry.js';
import { splitSqlStatements } from '../../src/database/migrations/sql-splitter.js';

const source = async (): Promise<string> =>
  readFile(
    new URL('../../src/database/migrations/sql/017_d9_board_invitations.up.sql', import.meta.url),
    'utf8',
  );

test('registers the forward-additive invitation and capability epoch migration', () => {
  assert.deepEqual(MIGRATION_REGISTRY.at(-6), {
    version: '017_d9_board_invitations',
    upAsset: '017_d9_board_invitations.up.sql',
    reversible: false,
    downAsset: null,
    postcondition: 'd9_board_invitations_v1',
  });
  assert.equal(MIGRATION_REGISTRY.at(-7)?.version, '016_d9_board_memberships');
});

test('pins digest-only tokens and one active identity regardless of role', async () => {
  const sql = await source();
  assert.equal(splitSqlStatements(sql).length, 5);
  assert.match(sql, /ADD COLUMN capability_epoch BIGINT UNSIGNED NOT NULL DEFAULT 0/u);
  assert.match(sql, /token_locator BINARY\(16\) NOT NULL/u);
  assert.match(sql, /token_digest BINARY\(32\) NOT NULL/u);
  assert.match(sql, /UNIQUE KEY uq_board_invitations_token_digest \(token_digest\)/u);
  assert.match(
    sql,
    /UNIQUE KEY uq_board_invitations_active_email \(board_pk, active_email_normalized\)/u,
  );
  assert.match(sql, /CASE WHEN state = 'pending' THEN email_normalized ELSE NULL END/u);
  assert.doesNotMatch(sql, /token_plain|raw_token|token_value/u);
});
