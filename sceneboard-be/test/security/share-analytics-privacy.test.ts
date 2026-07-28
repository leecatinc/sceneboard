import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import { isSuppressedShareView } from '../../src/share-analytics/context/share-view-classifier.js';

test('suppresses automation and prefetch using transient inputs only', () => {
  assert.equal(isSuppressedShareView({ userAgent: 'Mozilla/5.0' }), false);
  assert.equal(isSuppressedShareView({ userAgent: 'ExampleBot/1.0' }), true);
  assert.equal(isSuppressedShareView({ secPurpose: 'prefetch' }), true);
  assert.equal(isSuppressedShareView({ purpose: 'preview' }), true);
});

test('keeps forbidden viewer authority outside every analytics SQL sink', async () => {
  const sql = await readFile(
    new URL('../../src/database/migrations/sql/023_d9_share_analytics.up.sql', import.meta.url),
    'utf8',
  );
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
  assert.doesNotMatch(sql, /board_revision_holds|media_holds/iu);
});
