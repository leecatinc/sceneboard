import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AppError } from '../../src/common/errors/app-error.js';
import {
  accountApiKeyScopeMask,
  accountApiKeyScopesFromMask,
  parseAccountApiKeyScopes,
} from '../../src/api-keys/account-api-key.scope.js';

test('defaults an omitted selection to exactly board read and round trips every scope', () => {
  assert.deepEqual(parseAccountApiKeyScopes(undefined), ['board:read']);
  const scopes = [
    'board:archive',
    'board:create',
    'board:read',
    'board:write',
    'export:read',
    'history:read',
  ] as const;
  assert.equal(accountApiKeyScopeMask(scopes), 63);
  assert.deepEqual(accountApiKeyScopesFromMask(63), scopes);
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
