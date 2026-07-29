import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import { MIGRATION_REGISTRY } from '../../src/database/migrations/registry.js';

test('registers the forward-only share migration and exact durable ledgers', async () => {
  const sql = await readFile(
    new URL('../../src/database/migrations/sql/019_d9_board_shares.up.sql', import.meta.url),
    'utf8',
  );
  assert.deepEqual(
    MIGRATION_REGISTRY.find(({ version }) => version === '019_d9_board_shares'),
    {
      version: '019_d9_board_shares',
      upAsset: '019_d9_board_shares.up.sql',
      reversible: false,
      downAsset: null,
      postcondition: 'd9_board_shares_v1',
    },
  );
  for (const table of [
    'board_shares',
    'share_transition_recovery',
    'share_transition_recovery_items',
    'share_request_idempotency',
  ]) {
    assert.match(sql, new RegExp(`CREATE TABLE ${table}`, 'u'));
  }
  assert.match(sql, /UNIQUE KEY uq_board_shares_board \(board_pk\)/u);
  assert.match(sql, /UNIQUE KEY uq_board_shares_token_digest \(token_digest\)/u);
  assert.match(sql, /UNIQUE KEY uq_share_transition_recovery_active_board \(active_board_pk\)/u);
  assert.match(sql, /fk_share_transition_item_discovery/u);
  assert.match(sql, /credential_present TINYINT UNSIGNED NOT NULL DEFAULT 0/u);
  assert.match(sql, /chk_share_transition_recovery_credential_marker/u);
  assert.match(sql, /password_hash_sha256 BINARY\(32\) NULL/u);
  assert.match(sql, /operator_fence BIGINT UNSIGNED NOT NULL DEFAULT 0/u);
  assert.match(sql, /operator_evidence_sha256 BINARY\(32\) NULL/u);
  assert.match(sql, /chk_share_transition_recovery_operator/u);
  assert.doesNotMatch(sql, /link_token|plaintext_token/iu);
});

test('projects one strict share schema certificate', async () => {
  const projection = JSON.parse(
    await readFile(
      new URL('../contracts/schema-projections/d9-board-shares.json', import.meta.url),
      'utf8',
    ),
  ) as { tables: string[]; generations: string[]; secretPersistence: unknown };
  assert.equal(projection.tables.length, 4);
  assert.deepEqual(projection.generations, ['publication_generation', 'access_generation']);
  assert.deepEqual(projection.secretPersistence, {
    linkToken: 'never',
    tokenDigest: 'sha256-ascii-binary32',
  });
});
