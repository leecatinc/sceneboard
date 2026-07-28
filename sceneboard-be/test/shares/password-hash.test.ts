import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CryptoService } from '../../src/common/security/crypto.service.js';
import {
  PasswordHashService,
  SHARE_PASSWORD_ALPHABET,
  SHARE_PASSWORD_SCRYPT,
} from '../../src/shares/password-hash.service.js';

const key = Buffer.alloc(32, 7);
const keys = {
  sessionToken: key,
  grantToken: key,
  csrf: key,
  pairingCodePepper: key,
  auditHmac: key,
  rateLimitHmac: key,
};

test('generates exactly 120 uniform bits from the closed 32-symbol alphabet', () => {
  const source = Buffer.from(Array.from({ length: 24 }, (_, index) => index));
  const hasher = new PasswordHashService(new CryptoService(keys, () => source));
  const password = hasher.generate();
  assert.equal(password, SHARE_PASSWORD_ALPHABET.slice(0, 24));
  assert.equal(password.length, 24);
  assert.match(password, /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{24}$/u);
});

test('uses the frozen built-in scrypt tuple and constant-time verification', async () => {
  const crypto = new CryptoService(keys, (length) => Buffer.alloc(length, 11));
  const hasher = new PasswordHashService(crypto);
  const record = await hasher.hash('23456789ABCDEFGHJKLMNPQR');
  assert.deepEqual(SHARE_PASSWORD_SCRYPT, {
    N: 65_536,
    r: 8,
    p: 1,
    keylen: 32,
    maxmem: 100_663_296,
  });
  assert.equal(record.passwordHash.byteLength, 32);
  assert.equal(record.salt.byteLength, 16);
  assert.equal(record.hashVersion, 'S1');
  assert.equal(await hasher.verify('23456789ABCDEFGHJKLMNPQR', record), true);
  assert.equal(await hasher.verify('23456789ABCDEFGHJKLMNPQS', record), false);
  assert.equal(await hasher.verify('Ł'.repeat(24), record), false);
});
