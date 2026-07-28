import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import { MIGRATION_REGISTRY } from '../../src/database/migrations/registry.js';
import { splitSqlStatements } from '../../src/database/migrations/sql-splitter.js';

const sql = async () =>
  readFile(
    new URL('../../src/database/migrations/sql/020_d9_share_password_auth.up.sql', import.meta.url),
    'utf8',
  );

test('registers the forward-only password share migration after publication', async () => {
  assert.deepEqual(MIGRATION_REGISTRY.at(-2), {
    version: '020_d9_share_password_auth',
    upAsset: '020_d9_share_password_auth.up.sql',
    reversible: false,
    downAsset: null,
    postcondition: 'd9_share_password_auth_v1',
  });
  assert.equal(MIGRATION_REGISTRY.at(-3)?.version, '019_d9_board_shares');
  assert.equal(splitSqlStatements(await sql()).length, 7);
});

test('pins digest-only credential, family, grant and fenced cleanup projections', async () => {
  const source = await sql();
  for (const table of [
    'share_password_credentials',
    'share_password_session_families',
    'share_password_session_grants',
    'share_password_cleanup_leases',
  ]) {
    assert.match(source, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`, 'u'));
  }
  assert.match(source, /password_hash BINARY\(32\) NOT NULL/u);
  assert.match(source, /salt BINARY\(16\) NOT NULL/u);
  assert.match(source, /hash_version CHAR\(2\).*NOT NULL/u);
  assert.match(source, /PRIMARY KEY \(family_digest, share_pk\)/u);
  assert.match(source, /ON DELETE CASCADE/u);
  assert.match(source, /fence BIGINT UNSIGNED NOT NULL DEFAULT 0/u);
  assert.match(source, /'password\.enable','password\.regenerate','password\.disable'/u);
  assert.doesNotMatch(source, /plaintext|raw_password|password_value/u);
});
