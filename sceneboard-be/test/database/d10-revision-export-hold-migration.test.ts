import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import {
  assessRevisionExportHoldPostcondition,
  type RevisionExportHoldProjection,
} from '../../src/database/migrations/postconditions.js';

const projection = (): RevisionExportHoldProjection => ({
  columnType:
    "enum('published','media','artifact','idempotency','outbox','recovery','restore','export')",
  checkClause:
    "kind IN ('published','media','artifact','idempotency','outbox','recovery','restore','export')",
  primaryColumns: ['board_pk', 'revision_pk', 'kind', 'holder_id'],
  activeIndexColumns: ['board_pk', 'released_at', 'expires_at', 'revision_pk'],
  foreignKeyColumns: ['board_pk:board_pk', 'revision_pk:revision_pk'],
  holderCheckClause: 'CHAR_LENGTH(holder_id) BETWEEN 1 AND 191',
});

test('migration 027 appends export to the exact revision-hold ENUM and CHECK', async () => {
  assert.doesNotThrow(() => assessRevisionExportHoldPostcondition(projection()));
  const source = await readFile(
    new URL(
      '../../src/database/migrations/sql/027_d10_revision_export_hold.up.sql',
      import.meta.url,
    ),
    'utf8',
  );
  assert.equal((source.match(/'export'/gu) ?? []).length, 2);
  assert.match(source, /DROP CHECK chk_revision_holds_kind/u);
  assert.match(source, /ADD CONSTRAINT chk_revision_holds_kind/u);
  assert.doesNotMatch(source, /UPDATE|DELETE|INSERT/u);
});

test('revision export hold postcondition rejects order drift and narrowed projections', () => {
  assert.throws(() =>
    assessRevisionExportHoldPostcondition({
      ...projection(),
      columnType:
        "enum('published','media','artifact','idempotency','outbox','recovery','export','restore')",
    }),
  );
  assert.throws(() =>
    assessRevisionExportHoldPostcondition({
      ...projection(),
      checkClause:
        "kind IN ('published','media','artifact','idempotency','outbox','recovery','restore')",
    }),
  );
});
