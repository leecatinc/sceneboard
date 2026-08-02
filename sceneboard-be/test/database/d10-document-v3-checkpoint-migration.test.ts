import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import {
  assessDocumentV3CheckpointPostcondition,
  type DocumentV3CheckpointProjection,
} from '../../src/database/migrations/postconditions.js';

const rows = (): DocumentV3CheckpointProjection[] => [
  {
    tableName: 'board_revision_payloads',
    constraintName: 'chk_revision_payloads_checkpoint',
    checkClause: `codec = 'B' AND stored_bytes = OCTET_LENGTH(payload) AND (
      (schema_version = '1.0.0' AND canonical_bytes BETWEEN 1 AND 786432
       AND stored_bytes BETWEEN 1 AND 800000)
      OR (schema_version = '2.0.0' AND canonical_bytes BETWEEN 1 AND 20971520
       AND stored_bytes BETWEEN 1 AND 33554432)
      OR (schema_version = '3.0.0' AND canonical_bytes BETWEEN 1 AND 20971520
       AND stored_bytes BETWEEN 1 AND 33554432))`,
  } as DocumentV3CheckpointProjection,
  {
    tableName: 'board_revisions',
    constraintName: 'chk_revisions_retained_checkpoint',
    checkClause: `(scene_schema_version IS NULL AND scene_codec IS NULL
      AND scene_payload IS NULL AND scene_canonical_bytes IS NULL
      AND scene_stored_bytes IS NULL AND scene_sha256 IS NULL)
      OR (scene_schema_version IS NOT NULL AND scene_codec = 'B'
      AND scene_payload IS NOT NULL AND scene_canonical_bytes IS NOT NULL
      AND scene_stored_bytes = OCTET_LENGTH(scene_payload) AND scene_sha256 IS NOT NULL
      AND ((scene_schema_version = '1.0.0' AND scene_canonical_bytes BETWEEN 1 AND 786432
        AND scene_stored_bytes BETWEEN 1 AND 800000)
      OR (scene_schema_version = '2.0.0' AND scene_canonical_bytes BETWEEN 1 AND 20971520
        AND scene_stored_bytes BETWEEN 1 AND 33554432)
      OR (scene_schema_version = '3.0.0' AND scene_canonical_bytes BETWEEN 1 AND 20971520
        AND scene_stored_bytes BETWEEN 1 AND 33554432)))`,
  } as DocumentV3CheckpointProjection,
];

test('certifies exact V1/V2 preservation and V3 expansion at both checkpoint sites', async () => {
  assert.doesNotThrow(() => assessDocumentV3CheckpointPostcondition(rows()));
  const source = await readFile(
    new URL(
      '../../src/database/migrations/sql/026_d10_document_v3_checkpoint.up.sql',
      import.meta.url,
    ),
    'utf8',
  );
  assert.equal((source.match(/\n\s*schema_version = '3\.0\.0'/gu) ?? []).length, 1);
  assert.equal((source.match(/\n\s*scene_schema_version = '3\.0\.0'/gu) ?? []).length, 1);
  assert.match(source, /scene_sha256 IS NULL/u);
  assert.match(source, /scene_sha256 IS NOT NULL/u);
  assert.doesNotMatch(source, /UPDATE|DELETE|INSERT/u);
});

test('rejects missing or narrowed V3 checkpoint projections', () => {
  assert.throws(() => assessDocumentV3CheckpointPostcondition(rows().slice(0, 1)));
  const narrowed = rows();
  narrowed[0] = {
    ...narrowed[0],
    checkClause:
      narrowed[0]?.checkClause.replace("schema_version = '3.0.0'", "schema_version = '2.0.0'") ??
      '',
  } as DocumentV3CheckpointProjection;
  assert.throws(() => assessDocumentV3CheckpointPostcondition(narrowed));
});

test('rejects broadened, regrouped, and bound-drifted checkpoint predicates exactly', () => {
  const driftCases: ReadonlyArray<{
    row: 0 | 1;
    mutate: (clause: string) => string;
  }> = [
    { row: 0, mutate: (clause) => `(${clause}) OR TRUE` },
    { row: 0, mutate: (clause) => `(${clause}) OR 1 = 1` },
    {
      row: 0,
      mutate: (clause) =>
        clause.replace(
          "OR (schema_version = '3.0.0'",
          "OR (schema_version = '9.0.0' AND canonical_bytes BETWEEN 1 AND 20971520 AND stored_bytes BETWEEN 1 AND 33554432) OR (schema_version = '3.0.0'",
        ),
    },
    {
      row: 0,
      mutate: (clause) =>
        clause.replace(
          'canonical_bytes BETWEEN 1 AND 786432',
          'canonical_bytes BETWEEN 2 AND 786432',
        ),
    },
    {
      row: 0,
      mutate: (clause) => clause.replace("codec = 'B' AND stored_bytes", 'stored_bytes'),
    },
    {
      row: 0,
      mutate: (clause) =>
        clause.replace(
          "(schema_version = '1.0.0' AND canonical_bytes BETWEEN 1 AND 786432\n       AND stored_bytes BETWEEN 1 AND 800000)",
          "schema_version = '1.0.0' AND (canonical_bytes BETWEEN 1 AND 786432\n       AND stored_bytes BETWEEN 1 AND 800000",
        ),
    },
    { row: 1, mutate: (clause) => `(${clause}) OR TRUE` },
    { row: 1, mutate: (clause) => `(${clause}) OR 1 = 1` },
    {
      row: 1,
      mutate: (clause) =>
        clause.replace(
          "OR (scene_schema_version = '3.0.0'",
          "OR (scene_schema_version = '9.0.0' AND scene_canonical_bytes BETWEEN 1 AND 20971520 AND scene_stored_bytes BETWEEN 1 AND 33554432) OR (scene_schema_version = '3.0.0'",
        ),
    },
    {
      row: 1,
      mutate: (clause) =>
        clause.replace(
          'scene_stored_bytes BETWEEN 1 AND 33554432',
          'scene_stored_bytes BETWEEN 1 AND 33554431',
        ),
    },
    {
      row: 1,
      mutate: (clause) =>
        clause.replace('AND scene_sha256 IS NOT NULL', 'OR scene_sha256 IS NOT NULL'),
    },
    {
      row: 1,
      mutate: (clause) =>
        clause.replace(
          '(scene_schema_version IS NULL AND scene_codec IS NULL',
          'scene_schema_version IS NULL AND (scene_codec IS NULL',
        ),
    },
  ];
  for (const drift of driftCases) {
    const actual = rows();
    const source = actual[drift.row];
    assert.ok(source);
    actual[drift.row] = { ...source, checkClause: drift.mutate(source.checkClause) };
    assert.throws(() => assessDocumentV3CheckpointPostcondition(actual));
  }
});

test('accepts only cosmetic checkpoint predicate wrappers and token aliases', () => {
  const cosmetic = rows().map((row) => ({
    ...row,
    checkClause: `(((${row.checkClause.replaceAll('OCTET_LENGTH', 'length')})))`,
  }));
  assert.doesNotThrow(() => assessDocumentV3CheckpointPostcondition(cosmetic));
});
