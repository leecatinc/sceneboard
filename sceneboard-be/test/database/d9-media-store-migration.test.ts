import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import { MIGRATION_REGISTRY } from '../../src/database/migrations/registry.js';
import { splitSqlStatements } from '../../src/database/migrations/sql-splitter.js';

test('registers the exact forward-only immutable media store', async () => {
  assert.deepEqual(MIGRATION_REGISTRY.at(-3), {
    version: '021_d9_media_store',
    upAsset: '021_d9_media_store.up.sql',
    reversible: false,
    downAsset: null,
    postcondition: 'd9_media_store_v1',
  });
  const sql = await readFile(
    new URL('../../src/database/migrations/sql/021_d9_media_store.up.sql', import.meta.url),
    'utf8',
  );
  assert.equal(splitSqlStatements(sql).length, 4);
  assert.match(sql, /bytes LONGBLOB NOT NULL/u);
  assert.match(sql, /UNIQUE KEY uq_media_objects_sha256 \(sha256\)/u);
  assert.match(sql, /UNIQUE KEY uq_board_media_public_id \(media_id\)/u);
  assert.match(sql, /UNIQUE KEY uq_board_media_object \(board_pk, media_pk\)/u);
  assert.match(sql, /used_bytes <= 536870912/u);
  assert.match(sql, /PRIMARY KEY \(account_pk, board_pk, idempotency_key\)/u);
  assert.doesNotMatch(sql, /ON DELETE CASCADE/u);
  const projection = JSON.parse(
    await readFile(
      new URL('../contracts/schema-projections/d9-media-store.json', import.meta.url),
      'utf8',
    ),
  ) as {
    migration: string;
    reversible: boolean;
    tables: Record<string, unknown>;
  };
  assert.equal(projection.migration, '021_d9_media_store');
  assert.equal(projection.reversible, false);
  assert.deepEqual(Object.keys(projection.tables), [
    'media_objects',
    'board_media',
    'board_media_quota',
    'media_ingest_idempotency',
  ]);
  const runner = await readFile(
    new URL('../../src/database/migrations/runner.ts', import.meta.url),
    'utf8',
  );
  assert.match(
    runner,
    /postcondition === 'd9_media_store_v1'[\s\S]*?verifyMediaStoreSchema\(connection\)/u,
  );
  for (const contract of [
    'media store table projection mismatch',
    'media store index projection mismatch',
    'media store foreign-key projection mismatch',
    'media store check projection mismatch',
  ])
    assert.match(runner, new RegExp(contract, 'u'));
  assert.match(runner, /assertExactProjection\(\s*'media store column'/u);
});
