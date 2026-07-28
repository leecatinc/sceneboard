import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CryptoService } from '../../src/common/security/crypto.service.js';
import { ShareTokenService } from '../../src/shares/share-token.service.js';

const crypto = new CryptoService(
  {
    sessionToken: Buffer.alloc(32, 1),
    grantToken: Buffer.alloc(32, 2),
    csrf: Buffer.alloc(32, 3),
    pairingCodePepper: Buffer.alloc(32, 4),
    auditHmac: Buffer.alloc(32, 5),
    rateLimitHmac: Buffer.alloc(32, 6),
  },
  (length) => Buffer.alloc(length, 7),
);

test('issues an exact 256-bit base64url token and stores a SHA-256 digest only', () => {
  const service = new ShareTokenService(crypto);
  const issued = service.issue();
  assert.match(issued.token, /^[A-Za-z0-9_-]{43}$/u);
  assert.equal(issued.digest.byteLength, 32);
  assert.deepEqual(service.digest(issued.token), issued.digest);
  assert.equal(service.verify(issued.token, issued.digest), true);
  assert.equal(service.verify(`${issued.token.slice(0, 42)}A`, issued.digest), false);
});

test('rejects padded, short, long, and non-base64url token grammar', () => {
  const service = new ShareTokenService(crypto);
  for (const token of ['A'.repeat(42), 'A'.repeat(44), `${'A'.repeat(42)}=`, '💥']) {
    assert.throws(() => service.digest(token));
  }
});
