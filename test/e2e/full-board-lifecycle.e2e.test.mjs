import assert from 'node:assert/strict';
import test from 'node:test';
import { parseCertificationArguments } from '../../scripts/run-local-certification.mjs';

test('full local lifecycle is registered but remains a live certification gate', () => {
  assert.deepEqual(parseCertificationArguments(['--phase=e2e', '--profile=full-local']), {
    phase: 'e2e',
    profile: 'full-local',
  });
  assert.equal(process.env.SCENEBOARD_CERTIFICATION_LIVE_ADAPTER === 'approved-local-v1', false);
});
