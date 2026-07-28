import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  RETENTION_BATCH_MAX_STORED_BYTES,
  boundRetentionCandidatesV1,
  type RetentionCandidateV1,
} from '../../src/revisions/retention/retention.repository.js';

const candidate = (revisionPk: number, storedBytes: number): RetentionCandidateV1 => ({
  revisionPk: String(revisionPk),
  revisionNumber: revisionPk,
  storedBytes,
  anchorSha256: Buffer.alloc(32, revisionPk),
  payloadSha256: Buffer.alloc(32, revisionPk + 1),
});

test('always admits one exact 32 MiB revision and does not starve the batch', () => {
  assert.deepEqual(
    boundRetentionCandidatesV1([
      candidate(1, RETENTION_BATCH_MAX_STORED_BYTES),
      candidate(2, 1),
    ]).map((row) => row.revisionPk),
    ['1'],
  );
});

test('stops before the 101st revision or the row that crosses 32 MiB', () => {
  assert.equal(
    boundRetentionCandidatesV1(Array.from({ length: 101 }, (_, index) => candidate(index + 1, 1)))
      .length,
    100,
  );
  assert.deepEqual(
    boundRetentionCandidatesV1([
      candidate(1, RETENTION_BATCH_MAX_STORED_BYTES - 1),
      candidate(2, 2),
    ]).map((row) => row.revisionPk),
    ['1'],
  );
});
