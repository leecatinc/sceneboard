import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  assessDocumentReplaceIdempotencyPostcondition,
  type DocumentReplaceIdempotencyCheckProjection,
  type DocumentReplaceIdempotencyColumnProjection,
  type DocumentReplaceIdempotencyIndexProjection,
} from '../../src/database/migrations/postconditions.js';
import { splitSqlStatements } from '../../src/database/migrations/sql-splitter.js';

const columns = [
  ['fingerprint_payload', 'longblob', 'NO'],
  ['fingerprint_canonical_bytes', 'int unsigned', 'NO'],
  ['result_payload', 'longblob', 'YES'],
  ['result_canonical_bytes', 'int unsigned', 'YES'],
].map(
  ([columnName, columnType, isNullable]) =>
    ({ columnName, columnType, isNullable }) as DocumentReplaceIdempotencyColumnProjection,
);

const checks = [
  [
    'chk_idempotency_scope_shape',
    `(scope_code = 'C' AND scope_subject = 'board.create'
      AND expected_revision_id IS NULL AND operation_type = 'board.create')
      OR (scope_code = 'A' AND scope_subject <> 'board.create'
      AND expected_revision_id IS NULL AND operation_type = 'board.archive')
      OR (scope_code = 'M' AND scope_subject <> 'board.create'
      AND expected_revision_id IS NOT NULL AND operation_type IN (
        'scene.replace','scene.clear','scene.restore','hitl.request','hitl.respond',
        'artifact.publish','artifact.stop','document.replace'))`,
  ],
  [
    'chk_idempotency_fingerprint',
    `fingerprint_version = 1
      AND fingerprint_canonical_bytes BETWEEN 1 AND 33554432
      AND fingerprint_canonical_bytes = OCTET_LENGTH(fingerprint_payload)`,
  ],
  [
    'chk_idempotency_status',
    `(status_code = 'P' AND result_payload IS NULL
      AND result_canonical_bytes IS NULL AND result_sha256 IS NULL
      AND completed_at IS NULL AND expires_at IS NULL)
      OR (status_code = 'C' AND result_payload IS NOT NULL
      AND result_canonical_bytes IS NOT NULL
      AND result_canonical_bytes BETWEEN 1 AND 33554432
      AND result_canonical_bytes = OCTET_LENGTH(result_payload)
      AND result_sha256 IS NOT NULL
      AND completed_at IS NOT NULL AND expires_at IS NOT NULL
      AND expires_at > completed_at)`,
  ],
].map(
  ([constraintName, checkClause]) =>
    ({ constraintName, checkClause }) as DocumentReplaceIdempotencyCheckProjection,
);

const indexes = [
  ['uq_idempotency_scope', 0, 1, 'scope_code'],
  ['uq_idempotency_scope', 0, 2, 'principal_kind'],
  ['uq_idempotency_scope', 0, 3, 'principal_id'],
  ['uq_idempotency_scope', 0, 4, 'scope_subject'],
  ['uq_idempotency_scope', 0, 5, 'idempotency_key'],
].map(
  ([indexName, nonUnique, sequence, columnName]) =>
    ({ indexName, nonUnique, sequence, columnName }) as DocumentReplaceIdempotencyIndexProjection,
);

test('migration 028 expands document idempotency without rewriting pre-028 rows', async () => {
  const source = await readFile(
    new URL(
      '../../src/database/migrations/sql/028_d10_document_replace_idempotency.up.sql',
      import.meta.url,
    ),
    'utf8',
  );
  assert.equal(splitSqlStatements(source).length, 1);
  assert.match(source, /MODIFY COLUMN fingerprint_payload LONGBLOB NOT NULL/u);
  assert.match(source, /MODIFY COLUMN result_payload LONGBLOB NULL/u);
  assert.match(source, /'artifact\.stop','document\.replace'/u);
  assert.equal((source.match(/BETWEEN 1 AND 33554432/gu) ?? []).length, 2);
  assert.match(source, /fingerprint_canonical_bytes = OCTET_LENGTH\(fingerprint_payload\)/u);
  assert.match(source, /result_canonical_bytes = OCTET_LENGTH\(result_payload\)/u);
  assert.doesNotMatch(source, /\b(?:UPDATE|DELETE|INSERT|DROP\s+TABLE|TRUNCATE)\b/iu);
});

test('migration 028 semantic postcondition accepts fresh/adopt/restart shape only', () => {
  assert.doesNotThrow(() =>
    assessDocumentReplaceIdempotencyPostcondition(columns, checks, indexes),
  );

  const pendingAndCompletedRowsRemainCompatible = checks.find(
    ({ constraintName }) => constraintName === 'chk_idempotency_status',
  )?.checkClause;
  assert.match(pendingAndCompletedRowsRemainCompatible ?? '', /status_code = 'P'/u);
  assert.match(pendingAndCompletedRowsRemainCompatible ?? '', /status_code = 'C'/u);

  const narrowedChecks = checks.map((check) =>
    check.constraintName === 'chk_idempotency_scope_shape'
      ? { ...check, checkClause: check.checkClause.replace(",'document.replace'", '') }
      : { ...check },
  );
  assert.throws(
    () => assessDocumentReplaceIdempotencyPostcondition(columns, narrowedChecks, indexes),
    /check clause mismatch/u,
  );
  assert.throws(
    () =>
      assessDocumentReplaceIdempotencyPostcondition(
        columns.map((column) =>
          column.columnName === 'result_payload'
            ? { ...column, columnType: 'mediumblob' }
            : { ...column },
        ),
        checks,
        indexes,
      ),
    /column projection mismatch/u,
  );
  assert.throws(
    () => assessDocumentReplaceIdempotencyPostcondition(columns, checks, indexes.slice(0, -1)),
    /unique-key projection mismatch/u,
  );
});
