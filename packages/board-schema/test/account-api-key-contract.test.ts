import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  ACCOUNT_API_KEY_SCOPES_V1,
  ACCOUNT_API_KEY_SCOPE_BITS_V1,
  ACCOUNT_API_KEY_SCOPE_MASK_MAX_V1,
  accountApiKeyActorContextV1,
} from '../src/index.js';

test('freezes the account API-key scope catalog without widening pairing capabilities', () => {
  assert.deepEqual(ACCOUNT_API_KEY_SCOPES_V1, [
    'artifact:control',
    'artifact:publish',
    'board:archive',
    'board:create',
    'board:hitl:request',
    'board:hitl:respond',
    'board:media:write',
    'board:read',
    'board:write',
    'export:read',
    'history:read',
  ]);
  assert.deepEqual(ACCOUNT_API_KEY_SCOPE_BITS_V1, {
    'artifact:control': 64,
    'artifact:publish': 128,
    'board:archive': 1,
    'board:create': 2,
    'board:hitl:request': 256,
    'board:hitl:respond': 512,
    'board:media:write': 1024,
    'board:read': 4,
    'board:write': 8,
    'export:read': 16,
    'history:read': 32,
  });
  assert.equal(ACCOUNT_API_KEY_SCOPE_MASK_MAX_V1, 2047);
});

test('projects an account API key to the preserved service wire actor shape', () => {
  assert.deepEqual(accountApiKeyActorContextV1('key_public_1'), {
    principalKind: 'service',
    principalId: 'key_public_1',
    grantId: null,
    scopes: [],
  });
});
