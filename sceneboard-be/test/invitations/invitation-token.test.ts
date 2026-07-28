import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CryptoService } from '../../src/common/security/crypto.service.js';
import { InvitationTokenService } from '../../src/invitations/invitation-token.service.js';

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

test('issues one digest-only invitation credential and verifies exact token bytes', () => {
  const service = new InvitationTokenService(crypto);
  const issued = service.issue();
  assert.match(issued.token, /^lcbi_v1\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/u);
  assert.equal(issued.locator.byteLength, 16);
  assert.equal(issued.digest.byteLength, 32);
  assert.deepEqual(service.parseAndDigest(issued.token), {
    locator: issued.locator,
    digest: issued.digest,
  });
  assert.equal(service.verify(issued.token, issued.digest), true);
  assert.equal(service.verify(`${issued.token}x`, issued.digest), false);
});

test('rejects malformed, padded, and wrong-length invitation tokens', () => {
  const service = new InvitationTokenService(crypto);
  for (const token of [
    'lcbi_v1.bad.bad',
    'lcbi_v1.abc=.def',
    'lcbi_v1.BwcHBwcHBwcHBwcHBwcHBw.short',
    'lcbi_v2.a.b',
    '',
  ]) {
    assert.throws(() => service.parseAndDigest(token));
  }
});
