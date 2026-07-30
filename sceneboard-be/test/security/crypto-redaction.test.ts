import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CryptoService } from '../../src/common/security/crypto.service.js';
import { redactSecrets } from '../../src/common/security/redact-secrets.js';

const key = Buffer.alloc(32, 7);

const cryptoService = () =>
  new CryptoService({
    sessionToken: key,
    grantToken: key,
    csrf: key,
    pairingCodePepper: key,
    auditHmac: key,
    rateLimitHmac: key,
  });

test('generates exact public IDs and separates HKDF purpose keys', () => {
  const crypto = cryptoService();
  const ids = new Set(Array.from({ length: 100 }, () => crypto.generatePublicIdV1()));
  assert.equal(ids.size, 100);
  for (const id of ids) assert.match(id, /^[A-Za-z0-9_-]{22}$/);

  const input = Buffer.from('same-input');
  const session = crypto.hmac('session-token/v1', input);
  const grant = crypto.hmac('grant-token/v1', input);
  const cursor = crypto.hmac('grant-list-cursor/v1', input);
  const apiKey = crypto.hmac('account-api-key/v1', input);
  assert.equal(session.byteLength, 32);
  assert.notDeepEqual(session, grant);
  assert.notDeepEqual(grant, cursor);
  assert.notDeepEqual(grant, apiKey);
  assert.equal(crypto.constantTimeEqual(session, Buffer.from(session)), true);
  assert.equal(crypto.constantTimeEqual(session, grant), false);
});

test('redacts account API-key names and full token values while preserving publishable IDs', () => {
  const token = `sbk_v1.${'A'.repeat(22)}.${'B'.repeat(43)}`;
  assert.deepEqual(redactSecrets({ apiKey: token, apiKeyId: 'key_public_1' }), {
    apiKey: '[REDACTED]',
    apiKeyId: 'key_public_1',
  });
  assert.deepEqual(redactSecrets({ value: token, keyPublicId: 'key_public_1' }), {
    value: '[REDACTED]',
    keyPublicId: 'key_public_1',
  });
});

test('recursively redacts secret-shaped values without invoking accessors', () => {
  let getterCalls = 0;
  const hostile = Object.create(null) as Record<string, unknown>;
  Object.defineProperty(hostile, 'token', {
    enumerable: true,
    get: () => {
      getterCalls += 1;
      return 'must-not-run';
    },
  });
  hostile.password = 'secret';
  hostile.profile = { accessToken: 'secret', safe: 'visible' };
  hostile.items = [{ csrfToken: 'secret' }, 'ok'];
  hostile.self = hostile;

  const redacted = redactSecrets(hostile) as Record<string, unknown>;
  assert.equal(getterCalls, 0);
  assert.equal(redacted.password, '[REDACTED]');
  assert.deepEqual(redacted.profile, { accessToken: '[REDACTED]', safe: 'visible' });
  assert.deepEqual(redacted.items, [{ csrfToken: '[REDACTED]' }, 'ok']);
  assert.equal(redacted.token, '[REDACTED]');
  assert.equal(redacted.self, '[CIRCULAR]');
});

test('redacts every case-insensitive audit key class from the D2 contract', () => {
  const input = Object.fromEntries(
    [
      'password',
      'authorization',
      'cookie',
      'set-cookie',
      'token',
      'secret',
      'credential',
      'otp',
      'code',
      'proof',
      'challenge',
      'csrf',
      'hash',
    ].map((key) => [key.toUpperCase(), 'canary']),
  );
  assert.deepEqual(
    redactSecrets(input),
    Object.fromEntries(Object.keys(input).map((key) => [key, '[REDACTED]'])),
  );
});
