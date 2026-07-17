import assert from 'node:assert/strict';
import { test } from 'node:test';

import * as interactions from '../../src/interactions/index.js';

test('publishes only the D8 request, read, respond, lifecycle, snapshot, and module seams', () => {
  assert.deepEqual(Object.keys(interactions).sort(), [
    'CurrentHitlSummaryProvider',
    'HitlLifecycleApplicationPortV1',
    'HitlMutationApplicationPortV1',
    'HitlQueryApplicationPortV1',
    'InteractionsModule',
  ]);
});
