import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { MIGRATION_REGISTRY } from '../../src/database/migrations/registry.js';

test('revision retention backfill remains an irreversible registered migration', () => {
  const entry = MIGRATION_REGISTRY.find(
    ({ version }) => version === '030_d10_revision_retention_backfill',
  );
  assert.deepEqual(entry, {
    version: '030_d10_revision_retention_backfill',
    upAsset: '030_d10_revision_retention_backfill.up.sql',
    reversible: false,
    downAsset: null,
    postcondition: 'd10_revision_retention_backfill_v1',
  });
});

test('revision retention backfill copies only retained legacy checkpoints', () => {
  const source = readFileSync(
    new URL(
      '../../src/database/migrations/sql/030_d10_revision_retention_backfill.up.sql',
      import.meta.url,
    ),
    'utf8',
  );
  assert.match(source, /INSERT INTO board_revision_payloads/u);
  assert.match(source, /LEFT JOIN board_revision_payloads p/u);
  assert.match(source, /WHERE p\.revision_pk IS NULL/u);
  assert.match(source, /AND r\.scene_payload IS NOT NULL/u);
  assert.match(source, /INSERT INTO board_revision_catalog/u);
  assert.match(source, /r\.revision_number/u);
  assert.match(source, /CASE WHEN h\.head_revision_pk = r\.revision_pk THEN 1 ELSE 0 END/u);
  assert.match(source, /LEFT JOIN board_revision_catalog c/u);
  assert.match(source, /WHERE c\.revision_pk IS NULL/u);
});

test('revision retention backfill postcondition treats an empty revision set as complete', () => {
  const source = readFileSync(
    new URL('../../src/database/migrations/runner.ts', import.meta.url),
    'utf8',
  );
  assert.match(
    source,
    /CAST\(COALESCE\(SUM\(c\.revision_pk IS NULL\), 0\) AS CHAR\) AS missingCatalog/u,
  );
  assert.match(
    source,
    /CAST\(COALESCE\(SUM\(p\.revision_pk IS NULL\), 0\) AS CHAR\) AS missingPayload/u,
  );
});
