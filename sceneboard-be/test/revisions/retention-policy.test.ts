import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  completeRetainedRevisionBoundaryV1,
  createRevisionRetentionPolicyV1,
  truncatedRetainedRevisionBoundaryV1,
} from '../../src/revisions/retention/retention-policy.js';
import {
  REVISION_RETENTION_DEFAULT,
  REVISION_RETENTION_MAXIMUM,
  REVISION_RETENTION_MINIMUM,
} from '../../src/revisions/retention/retention.types.js';

test('creates the closed server-authoritative retention policy at both boundaries', () => {
  assert.equal(REVISION_RETENTION_DEFAULT, 32);
  assert.deepEqual(createRevisionRetentionPolicyV1(REVISION_RETENTION_MINIMUM), {
    accessibleRevisionCount: 1,
  });
  assert.deepEqual(createRevisionRetentionPolicyV1(REVISION_RETENTION_MAXIMUM), {
    accessibleRevisionCount: 256,
  });
  for (const invalid of [0, 257, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => createRevisionRetentionPolicyV1(invalid), TypeError);
  }
});

test('projects explicit complete and truncated boundaries without a predecessor identifier', () => {
  assert.deepEqual(completeRetainedRevisionBoundaryV1(), { kind: 'complete' });
  assert.deepEqual(truncatedRetainedRevisionBoundaryV1(17), {
    kind: 'truncated',
    oldestAccessibleRevisionNumber: 17,
  });
  assert.deepEqual(Object.keys(truncatedRetainedRevisionBoundaryV1(1)).sort(), [
    'kind',
    'oldestAccessibleRevisionNumber',
  ]);
  for (const invalid of [0, 1.5, 9_007_199_254_740_992]) {
    assert.throws(() => truncatedRetainedRevisionBoundaryV1(invalid), TypeError);
  }
});
