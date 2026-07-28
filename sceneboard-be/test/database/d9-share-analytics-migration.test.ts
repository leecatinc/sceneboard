import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import { MIGRATION_REGISTRY } from '../../src/database/migrations/registry.js';
import { splitSqlStatements } from '../../src/database/migrations/sql-splitter.js';

test('registers the forward-only privacy-minimized share analytics migration', async () => {
  assert.deepEqual(MIGRATION_REGISTRY.at(-1), {
    version: '023_d9_share_analytics',
    upAsset: '023_d9_share_analytics.up.sql',
    reversible: false,
    downAsset: null,
    postcondition: 'd9_share_analytics_v1',
  });
  const sql = await readFile(
    new URL('../../src/database/migrations/sql/023_d9_share_analytics.up.sql', import.meta.url),
    'utf8',
  );
  assert.equal(splitSqlStatements(sql).length, 8);
  for (const derivative of [
    'replay_family_key BINARY(32)',
    'viewer_dedupe_key BINARY(32)',
    'viewer_daily_key BINARY(32)',
  ])
    assert.match(sql, new RegExp(derivative.replace(/[()]/gu, '\\$&'), 'u'));
  for (const forbidden of [
    'ip_address',
    'user_agent',
    'account_pk',
    'viewer_seed',
    'share_token',
    'password_hash',
    'csrf_token',
  ])
    assert.doesNotMatch(sql, new RegExp(forbidden, 'iu'));
  assert.match(sql, /expires_at <= created_at \+ INTERVAL 48 HOUR/u);
  assert.match(sql, /expires_at <= last_counted_at \+ INTERVAL 48 HOUR/u);
  assert.doesNotMatch(sql, /board_revision_holds|media_holds|ON DELETE CASCADE/u);
});
