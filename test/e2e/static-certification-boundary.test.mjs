import assert from 'node:assert/strict';
import test from 'node:test';

test('static certification never represents unavailable live infrastructure as passing evidence', () => {
  const liveOnlyPhases = [
    'database',
    'restore',
    'redis-loss',
    'multi-client',
    'security',
    'e2e',
    'operations',
    'capacity',
    'release',
  ];
  assert.equal(new Set(liveOnlyPhases).size, liveOnlyPhases.length);
  assert.equal(liveOnlyPhases.includes('static'), false);
});
