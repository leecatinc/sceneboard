import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import { decideShareRecoveryAction } from '../../src/shares/share-transition-recovery.service.js';

test('closes every planned/core/quarantined recovery adoption row', () => {
  assert.equal(decideShareRecoveryAction('planned', 'before', null), 'resume_core');
  assert.equal(decideShareRecoveryAction('planned', 'after', null), 'adopt_core_applied');
  assert.equal(decideShareRecoveryAction('planned', 'neither', null), 'quarantine');
  assert.equal(decideShareRecoveryAction('core_applied', 'after', null), 'committed_cleanup');
  assert.equal(decideShareRecoveryAction('core_applied', 'before', null), 'quarantine');
  assert.equal(decideShareRecoveryAction('quarantined', 'before', null), 'safe_abort');
  assert.equal(decideShareRecoveryAction('quarantined', 'after', null), 'committed_cleanup');
  assert.equal(decideShareRecoveryAction('quarantined', 'neither', null), 'quarantine');
  assert.equal(decideShareRecoveryAction('complete', 'after', 'committed'), 'noop');
  assert.equal(decideShareRecoveryAction('complete', 'before', 'aborted'), 'noop');
});

test('owns bounded DB-time claims and converges observed recovery rows', async () => {
  const source = await readFile(
    new URL('../../src/shares/share-transition-recovery.service.ts', import.meta.url),
    'utf8',
  );
  assert.match(source, /async claim\(/u);
  assert.match(source, /operator_fence = operator_fence \+ 1/u);
  assert.match(source, /operator_evidence_sha256 = \?/u);
  assert.match(source, /lease_expires_at <= CURRENT_TIMESTAMP\(3\)/u);
  assert.match(source, /async reconcileObserved\(/u);
  assert.match(source, /outcome = 'aborted'/u);
  assert.match(source, /async adoptCoreApplied\(/u);
  assert.match(source, /OBSERVED_STATE_MISMATCH/u);
});
