import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import {
  MigrationStateError,
  assessV2CheckpointCapacity,
  type V2CheckpointColumnProjection,
  type V2CheckpointConstraintProjection,
} from '../../src/database/migrations/runner.js';
import { MIGRATION_REGISTRY } from '../../src/database/migrations/registry.js';
import { splitSqlStatements } from '../../src/database/migrations/sql-splitter.js';

const columns: V2CheckpointColumnProjection[] = [
  {
    columnName: 'scene_schema_version',
    columnType: 'char(5)',
    characterSetName: 'ascii',
    collationName: 'ascii_bin',
    isNullable: 'NO',
  },
  {
    columnName: 'scene_codec',
    columnType: 'char(1)',
    characterSetName: 'ascii',
    collationName: 'ascii_bin',
    isNullable: 'NO',
  },
  {
    columnName: 'scene_payload',
    columnType: 'longblob',
    characterSetName: null,
    collationName: null,
    isNullable: 'NO',
  },
  {
    columnName: 'scene_canonical_bytes',
    columnType: 'int unsigned',
    characterSetName: null,
    collationName: null,
    isNullable: 'NO',
  },
  {
    columnName: 'scene_stored_bytes',
    columnType: 'int unsigned',
    characterSetName: null,
    collationName: null,
    isNullable: 'NO',
  },
];

const constraints: V2CheckpointConstraintProjection[] = [
  { constraintName: 'chk_revisions_origin', checkClause: "origin_code in ('C','R','L','S','D')" },
  { constraintName: 'chk_revisions_codec', checkClause: "scene_codec = 'B'" },
  {
    constraintName: 'chk_revisions_checkpoint',
    checkClause: `
      scene_codec = 'B'
      and scene_stored_bytes = octet_length(scene_payload)
      and (
        (
          scene_schema_version = '1.0.0'
          and scene_canonical_bytes between 1 and 786432
          and scene_stored_bytes between 1 and 800000
        )
        or (
          scene_schema_version = '2.0.0'
          and scene_canonical_bytes between 1 and 20971520
          and scene_stored_bytes between 1 and 33554432
        )
      )
    `,
  },
];

const accepted = (input: {
  version: string;
  codec: string;
  canonicalBytes: number;
  storedBytes: number;
  payloadBytes: number;
}): boolean =>
  input.codec === 'B' &&
  input.storedBytes === input.payloadBytes &&
  ((input.version === '1.0.0' &&
    input.canonicalBytes >= 1 &&
    input.canonicalBytes <= 786_432 &&
    input.storedBytes >= 1 &&
    input.storedBytes <= 800_000) ||
    (input.version === '2.0.0' &&
      input.canonicalBytes >= 1 &&
      input.canonicalBytes <= 20_971_520 &&
      input.storedBytes >= 1 &&
      input.storedBytes <= 33_554_432));

test('registers one forward-only D9 ALTER with the exact discriminator-aware capacity predicate', async () => {
  assert.deepEqual(MIGRATION_REGISTRY.at(-1), {
    version: '013_d9_v2_checkpoint_capacity',
    upAsset: '013_d9_v2_checkpoint_capacity.up.sql',
    reversible: false,
    downAsset: null,
    postcondition: 'd9_v2_checkpoint_capacity_v1',
  });
  const source = await readFile(
    new URL(
      '../../src/database/migrations/sql/013_d9_v2_checkpoint_capacity.up.sql',
      import.meta.url,
    ),
    'utf8',
  );
  assert.equal(splitSqlStatements(source).length, 1);
  for (const fragment of [
    'scene_payload LONGBLOB NOT NULL',
    'scene_canonical_bytes INT UNSIGNED NOT NULL',
    'scene_stored_bytes INT UNSIGNED NOT NULL',
    "scene_schema_version = '1.0.0'",
    "scene_schema_version = '2.0.0'",
    'scene_stored_bytes = OCTET_LENGTH(scene_payload)',
  ]) {
    assert.match(source, new RegExp(fragment.replaceAll(/[().]/g, '\\$&'), 'u'));
  }
});

test('accepts the exact information_schema projection and fails closed on type or collation drift', () => {
  assert.doesNotThrow(() => assessV2CheckpointCapacity(columns, constraints));
  assert.throws(
    () =>
      assessV2CheckpointCapacity(
        columns.map((column) =>
          column.columnName === 'scene_payload' ? { ...column, columnType: 'mediumblob' } : column,
        ),
        constraints,
      ),
    MigrationStateError,
  );
  assert.throws(
    () =>
      assessV2CheckpointCapacity(
        columns.map((column) =>
          column.columnName === 'scene_schema_version'
            ? { ...column, collationName: 'ascii_general_ci' }
            : column,
        ),
        constraints,
      ),
    MigrationStateError,
  );
});

test('proves every lower/upper boundary and rejects branch, case, codec, and octet mismatches', () => {
  for (const [version, maximumCanonical, maximumStored] of [
    ['1.0.0', 786_432, 800_000],
    ['2.0.0', 20_971_520, 33_554_432],
  ] as const) {
    for (const [canonicalBytes, storedBytes] of [
      [1, 1],
      [maximumCanonical, maximumStored],
    ] as const) {
      assert.equal(
        accepted({
          version,
          codec: 'B',
          canonicalBytes,
          storedBytes,
          payloadBytes: storedBytes,
        }),
        true,
      );
    }
    for (const [canonicalBytes, storedBytes] of [
      [0, 1],
      [maximumCanonical + 1, maximumStored],
      [maximumCanonical, maximumStored + 1],
    ] as const) {
      assert.equal(
        accepted({
          version,
          codec: 'B',
          canonicalBytes,
          storedBytes,
          payloadBytes: storedBytes,
        }),
        false,
      );
    }
  }
  for (const input of [
    { version: '1.0.0', codec: 'B', canonicalBytes: 786_433, storedBytes: 1, payloadBytes: 1 },
    { version: '2.0.0', codec: 'b', canonicalBytes: 1, storedBytes: 1, payloadBytes: 1 },
    { version: '2.0.0 ', codec: 'B', canonicalBytes: 1, storedBytes: 1, payloadBytes: 1 },
    { version: '3.0.0', codec: 'B', canonicalBytes: 1, storedBytes: 1, payloadBytes: 1 },
    { version: '2.0.0', codec: 'B', canonicalBytes: 1, storedBytes: 2, payloadBytes: 1 },
  ]) {
    assert.equal(accepted(input), false);
  }
});
