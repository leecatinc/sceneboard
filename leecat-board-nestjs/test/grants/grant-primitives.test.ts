import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AppError } from '../../src/common/errors/app-error.js';
import { CryptoService } from '../../src/common/security/crypto.service.js';
import { GrantCursorService } from '../../src/grants/grant-cursor.service.js';
import { parseGrantListQuery } from '../../src/grants/grant.dto.js';

const key = Buffer.alloc(32, 6);
const crypto = new CryptoService({
  sessionToken: key,
  grantToken: key,
  csrf: key,
  pairingCodePepper: key,
  auditHmac: key,
  rateLimitHmac: key,
});

test('grant cursor binds one canonical keyset tuple to its authenticated owner', () => {
  const cursors = new GrantCursorService(crypto);
  const cursor = cursors.issue('user_1', { createdAt: '2027-01-15T08:00:00.000Z', id: '42' });
  assert.match(cursor, /^lcgc_v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(cursors.parse('user_1', cursor), { createdAt: '2027-01-15T08:00:00.000Z', id: '42' });
  assert.throws(() => cursors.parse('user_2', cursor), (error) => error instanceof AppError && error.code === 'INVALID_PAYLOAD');
  assert.throws(() => cursors.parse('user_1', `${cursor}A`), (error) => error instanceof AppError && error.code === 'INVALID_PAYLOAD');
});

test('grant list query accepts only opaque cursor and canonical decimal limit', () => {
  assert.deepEqual(parseGrantListQuery({}), { cursor: null, limit: 25 });
  assert.deepEqual(parseGrantListQuery({ cursor: 'opaque', limit: '100' }), { cursor: 'opaque', limit: 100 });
  for (const invalid of [{ limit: '01' }, { limit: '0' }, { limit: '101' }, { other: '1' }, { cursor: ['x'] }]) {
    assert.throws(() => parseGrantListQuery(invalid), (error) => error instanceof AppError && error.code === 'INVALID_PAYLOAD');
  }
});
