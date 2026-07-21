import assert from 'node:assert/strict';
import test from 'node:test';
import { parseCertificationArguments } from '../../scripts/run-local-certification.mjs';

test('release accepts non-production only and cannot authorize deployment', () => {
  assert.deepEqual(parseCertificationArguments(['--phase=release', '--profile=non-production']), {
    phase: 'release',
    profile: 'non-production',
  });
  assert.throws(
    () => parseCertificationArguments(['--phase=release', '--profile=production']),
    (error) => error?.code === 'PRODUCTION_TARGET_FORBIDDEN',
  );
});
