import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ACCOUNT_API_KEY_SCOPE_BITS_V1 } from '@sceneboard/board-schema';

import { AppError } from '../../src/common/errors/app-error.js';
import {
  accountApiKeyScopeMask,
  accountApiKeyScopesFromMask,
  parseAccountApiKeyScopes,
} from '../../src/api-keys/account-api-key.scope.js';

test('defaults an omitted selection to exactly board read and round trips every scope', () => {
  assert.deepEqual(parseAccountApiKeyScopes(undefined), ['board:read']);
  const scopes = [
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
  ] as const;
  assert.equal(accountApiKeyScopeMask(scopes), 2047);
  assert.deepEqual(accountApiKeyScopesFromMask(2047), scopes);
  assert.deepEqual(accountApiKeyScopesFromMask(36), ['board:read', 'history:read']);
});

test('preserves every legacy bit meaning and appends new scopes only at bits 6 through 10', () => {
  const expected = {
    'board:archive': 1,
    'board:create': 2,
    'board:read': 4,
    'board:write': 8,
    'export:read': 16,
    'history:read': 32,
    'artifact:control': 64,
    'artifact:publish': 128,
    'board:hitl:request': 256,
    'board:hitl:respond': 512,
    'board:media:write': 1024,
  } as const;
  assert.deepEqual(ACCOUNT_API_KEY_SCOPE_BITS_V1, expected);
  for (const [scope, bit] of Object.entries(expected)) {
    assert.deepEqual(accountApiKeyScopesFromMask(bit), [scope]);
  }
  assert.deepEqual(accountApiKeyScopesFromMask(63), [
    'board:archive',
    'board:create',
    'board:read',
    'board:write',
    'export:read',
    'history:read',
  ]);
  assert.deepEqual(accountApiKeyScopesFromMask(36), ['board:read', 'history:read']);
  for (const mask of [0, 2048]) {
    assert.throws(
      () => accountApiKeyScopesFromMask(mask),
      (error: unknown) => error instanceof AppError && error.code === 'SERVICE_UNAVAILABLE',
    );
  }
});

test('rejects empty, unknown, duplicate, and non-canonical scope selections', () => {
  for (const input of [
    [],
    ['unknown'],
    ['board:read', 'board:read'],
    ['history:read', 'board:read'],
  ]) {
    assert.throws(
      () => parseAccountApiKeyScopes(input),
      (error: unknown) => error instanceof AppError && error.code === 'INVALID_PAYLOAD',
    );
  }
});
