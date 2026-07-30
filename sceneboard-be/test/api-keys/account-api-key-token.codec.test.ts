import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AccountApiKeyTokenCodec } from '../../src/api-keys/account-api-key-token.codec.js';
import { CryptoService } from '../../src/common/security/crypto.service.js';

const key = Buffer.alloc(32, 11);

const cryptoService = () => {
  let value = 0;
  return new CryptoService(
    {
      sessionToken: key,
      grantToken: key,
      csrf: key,
      pairingCodePepper: key,
      auditHmac: key,
      rateLimitHmac: key,
    },
    (length) => Buffer.alloc(length, (value += 1)),
  );
};

test('issues the strict 73-character grammar and verifies only the account-key purpose hash', () => {
  const crypto = cryptoService();
  const codec = new AccountApiKeyTokenCodec(crypto);
  const issued = codec.issue();
  assert.equal(/^sbk_v1\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/.test(issued.token), true);
  assert.equal(issued.token.length, 73);
  assert.equal(codec.parse(issued.token).locator.byteLength, 16);
  assert.equal(codec.verify(issued.token, issued.tokenHash), true);
  assert.equal(codec.verify(issued.token, crypto.hmac('grant-token/v1', issued.token)), false);
  assert.match(codec.prefix(issued.locator), /^sbk_v1\.[A-Za-z0-9_-]{8}…$/);
});

test('rejects malformed versions and non-canonical locator or secret lengths', () => {
  const codec = new AccountApiKeyTokenCodec(cryptoService());
  for (const value of [
    'not-a-token',
    'sbk_v2.a.b',
    'sbk_v1.short.short',
    'sbk_v1.AAAAAAAAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
  ]) {
    assert.equal(codec.verify(value, Buffer.alloc(32)), false);
  }
});
