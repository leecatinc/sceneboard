import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CryptoService } from '../../src/common/security/crypto.service.js';
import { ShareContractError } from '../../src/common/errors/app-error.js';
import {
  PasswordAttemptService,
  SHARE_PASSWORD_ATTEMPT_LUA,
} from '../../src/shares/password-attempt.service.js';

const key = Buffer.alloc(32, 8);
const crypto = new CryptoService({
  sessionToken: key,
  grantToken: key,
  csrf: key,
  pairingCodePepper: key,
  auditHmac: key,
  rateLimitHmac: key,
});

test('uses one Redis-TIME script with independent 5/10 thresholds and bounded TTL', async () => {
  let captured: { keys: readonly string[]; args: readonly string[] } | null = null;
  const attempts = new PasswordAttemptService(
    {
      evaluate: async (_script, keys, args) => {
        captured = { keys, args };
        return [0, 0];
      },
    },
    crypto,
    'sceneboard:',
  );
  await attempts.recordFailure(Buffer.alloc(32, 1), '203.0.113.7');
  assert.equal(captured!.keys.length, 4);
  assert.equal(captured!.args[0], 'failure');
  assert.equal(
    captured!.keys.every((value) => !value.includes('203.0.113.7')),
    true,
  );
  assert.match(SHARE_PASSWORD_ATTEMPT_LUA, /redis\.call\('TIME'\)/u);
  assert.match(SHARE_PASSWORD_ATTEMPT_LUA, /linkCount >= 5/u);
  assert.match(SHARE_PASSWORD_ATTEMPT_LUA, /ipCount >= 10/u);
  assert.match(SHARE_PASSWORD_ATTEMPT_LUA, /'EX', 1800/u);
});

test('maps an active lock and Redis loss to the exact fail-closed errors', async () => {
  const locked = new PasswordAttemptService(
    { evaluate: async () => [1, 37] },
    crypto,
    'sceneboard:',
  );
  await assert.rejects(
    () => locked.assertUnlocked(Buffer.alloc(32, 2), '203.0.113.8'),
    (error: unknown) =>
      error instanceof ShareContractError &&
      error.code === 'SHARE_PASSWORD_LOCKED' &&
      error.retryAfterSeconds === 37,
  );
  const unavailable = new PasswordAttemptService(
    { evaluate: async () => Promise.reject(new Error('down')) },
    crypto,
    'sceneboard:',
  );
  await assert.rejects(
    () => unavailable.assertUnlocked(Buffer.alloc(32, 3), '203.0.113.9'),
    (error: unknown) =>
      error instanceof ShareContractError &&
      error.code === 'SERVICE_UNAVAILABLE' &&
      error.retryAfterSeconds === 1,
  );
});
