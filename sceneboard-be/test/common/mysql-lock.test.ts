import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isMysqlLockAcquired } from '../../src/common/database/mysql-lock.js';

test('accepts only canonical numeric and string MySQL lock success values', () => {
  assert.equal(isMysqlLockAcquired(1), true);
  assert.equal(isMysqlLockAcquired('1'), true);
  for (const value of [0, '0', null, undefined, true, '01', 1n]) {
    assert.equal(isMysqlLockAcquired(value), false);
  }
});
