import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import { MIGRATION_REGISTRY } from '../../src/database/migrations/registry.js';
import { splitSqlStatements } from '../../src/database/migrations/sql-splitter.js';

test('registers the exact forward-only revision media reference migration', async () => {
  assert.deepEqual(MIGRATION_REGISTRY.at(-6), {
    version: '018_d9_board_revision_media_refs',
    upAsset: '018_d9_board_revision_media_refs.up.sql',
    reversible: false,
    downAsset: null,
    postcondition: 'd9_board_revision_media_refs_v1',
  });
  const sql = await readFile(
    new URL(
      '../../src/database/migrations/sql/018_d9_board_revision_media_refs.up.sql',
      import.meta.url,
    ),
    'utf8',
  );
  assert.equal(splitSqlStatements(sql).length, 1);
  assert.match(sql, /PRIMARY KEY \(revision_pk, media_id\)/u);
  assert.match(sql, /UNIQUE KEY uq_revision_media_ref_order \(revision_pk, ordinal\)/u);
  assert.match(sql, /KEY ix_revision_media_ref_lookup \(board_pk, media_id, revision_pk\)/u);
  assert.match(
    sql,
    /FOREIGN KEY \(board_pk, revision_pk\)\s+REFERENCES board_revisions \(board_pk, revision_pk\)/u,
  );
  assert.doesNotMatch(sql, /REFERENCES board_media/u);
  const projection = JSON.parse(
    await readFile(
      new URL('../contracts/schema-projections/d9-board-revision-media-refs.json', import.meta.url),
      'utf8',
    ),
  ) as {
    migration: string;
    primaryKey: string[];
    uniqueOrderKey: string[];
    lookupIndex: string[];
    mediaForeignKey: null;
  };
  assert.equal(projection.migration, '018_d9_board_revision_media_refs');
  assert.deepEqual(projection.primaryKey, ['revision_pk', 'media_id']);
  assert.deepEqual(projection.uniqueOrderKey, ['revision_pk', 'ordinal']);
  assert.deepEqual(projection.lookupIndex, ['board_pk', 'media_id', 'revision_pk']);
  assert.equal(projection.mediaForeignKey, null);
});
