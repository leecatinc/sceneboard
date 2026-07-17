import assert from 'node:assert/strict';
import test from 'node:test';
import { parseCertificationArguments } from '../../scripts/run-local-certification.mjs';

test('capacity is a distinct representative lane with no invented thresholds', () => {
  assert.deepEqual(parseCertificationArguments(['--phase=capacity', '--profile=representative']), {
    phase: 'capacity', profile: 'representative',
  });
  const requiredMeasuredFields = ['unit', 'sampleCount', 'fixtureSha256', 'distribution', 'ownerApproval'];
  assert.equal(requiredMeasuredFields.length, 5);
  assert.equal(requiredMeasuredFields.includes('productionSlo'), false);
});
