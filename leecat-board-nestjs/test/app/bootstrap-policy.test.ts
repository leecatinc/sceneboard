import assert from 'node:assert/strict';
import { test } from 'node:test';

import { requiresHeavyPersistenceCertification } from '../../src/bootstrap/bootstrap-policy.js';

test('requires heavyweight persistence certification only for staging and production', () => {
  assert.equal(requiresHeavyPersistenceCertification('development'), false);
  assert.equal(requiresHeavyPersistenceCertification('test'), false);
  assert.equal(requiresHeavyPersistenceCertification('staging'), true);
  assert.equal(requiresHeavyPersistenceCertification('production'), true);
});
