import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import { MIGRATION_REGISTRY } from '../../src/database/migrations/registry.js';
import { splitSqlStatements } from '../../src/database/migrations/sql-splitter.js';

test('registers the exact fenced media retention and recovery ledger', async () => {
  assert.deepEqual(MIGRATION_REGISTRY.at(-1), {
    version: '022_d9_media_retention_recovery',
    upAsset: '022_d9_media_retention_recovery.up.sql',
    reversible: false,
    downAsset: null,
    postcondition: 'd9_media_retention_recovery_v1',
  });
  const sql = await readFile(
    new URL(
      '../../src/database/migrations/sql/022_d9_media_retention_recovery.up.sql',
      import.meta.url,
    ),
    'utf8',
  );
  assert.equal(splitSqlStatements(sql).length, 4);
  assert.match(
    sql,
    /'intent',[\s\S]*'ownership_quarantined',[\s\S]*'refs_rechecked',[\s\S]*'ownership_released',[\s\S]*'object_quarantined',[\s\S]*'object_deleted',[\s\S]*'complete',[\s\S]*'quarantined'/u,
  );
  assert.match(sql, /delete_after = object_quarantined_at \+ INTERVAL 7 DAY/u);
  assert.match(sql, /media_manifest_sha256 BINARY\(32\) NOT NULL/u);
  assert.match(sql, /signature BINARY\(32\) NOT NULL/u);
  assert.match(sql, /PRIMARY KEY \(deployment_id, attempt_seq, media_pk\)/u);
  assert.doesNotMatch(sql, /ON DELETE CASCADE/u);
  const runner = await readFile(
    new URL('../../src/database/migrations/runner.ts', import.meta.url),
    'utf8',
  );
  assert.match(
    runner,
    /postcondition === 'd9_media_retention_recovery_v1'[\s\S]*verifyMediaRetentionRecoverySchema\(connection\)/u,
  );
  for (const contract of [
    'media retention table projection mismatch',
    'media retention column projection mismatch',
    'media retention index projection mismatch',
    'media retention foreign-key projection mismatch',
    'media retention check projection mismatch',
  ])
    assert.match(runner, new RegExp(contract, 'u'));
});
