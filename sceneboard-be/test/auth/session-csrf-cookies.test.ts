import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CookieService } from '../../src/auth/cookie.service.js';
import { CsrfService } from '../../src/auth/csrf.service.js';
import { SessionTokenService } from '../../src/auth/session-token.service.js';
import { CryptoService } from '../../src/common/security/crypto.service.js';

const key = Buffer.alloc(32, 9);
let randomByte = 0;
const crypto = new CryptoService(
  {
    sessionToken: key,
    grantToken: key,
    csrf: key,
    pairingCodePepper: key,
    auditHmac: key,
    rateLimitHmac: key,
  },
  (length) => Buffer.alloc(length, (randomByte = (randomByte + 1) % 255)),
);

test('issues and verifies one opaque session credential without persisting raw material', () => {
  const service = new SessionTokenService(crypto);
  const issued = service.issue();
  assert.match(issued.token, /^lcbs_v1\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/);
  assert.equal(issued.locator.byteLength, 16);
  assert.equal(issued.tokenHash.byteLength, 32);
  const parsed = service.parse(issued.token);
  assert.deepEqual(parsed.locator, issued.locator);
  assert.equal(service.verify(issued.token, issued.tokenHash), true);
  assert.equal(service.verify(issued.token.replace(/.$/, 'A'), issued.tokenHash), false);
  for (const value of ['', 'lcbs_v1.bad.bad', `${issued.token}.extra`])
    assert.throws(() => service.parse(value));
});

test('separates anonymous/session CSRF domains and binds sessions to one family', () => {
  const service = new CsrfService(crypto);
  const now = 1_800_000_000_000;
  const anonymous = service.issueAnonymous(now);
  assert.match(
    anonymous.token,
    /^lcbcsrf_v1\.a\.-\.[A-Za-z0-9_-]{22}\.[0-9]{13}\.[A-Za-z0-9_-]{43}$/,
  );
  assert.equal(service.verify(anonymous.token, { kind: 'anonymous', now }), true);
  assert.equal(
    service.verify(anonymous.token, { kind: 'session', familyPublicId: 'family_1', now }),
    false,
  );

  const session = service.issueSession('family_1', now, now + 60_000);
  assert.match(
    session.token,
    /^lcbcsrf_v1\.s\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{22}\.[0-9]{13}\.[A-Za-z0-9_-]{43}$/,
  );
  assert.equal(
    service.verify(session.token, { kind: 'session', familyPublicId: 'family_1', now }),
    true,
  );
  assert.equal(
    service.verify(session.token, { kind: 'session', familyPublicId: 'family_2', now }),
    false,
  );
  assert.equal(
    service.verify(session.token, {
      kind: 'session',
      familyPublicId: 'family_1',
      now: now + 60_001,
    }),
    false,
  );
  assert.match(service.authGeneration('s', 'session_1', session.token), /^[A-Za-z0-9_-]{22}$/);
  assert.equal(service.authGeneration('cleared', null, null), 'cleared');
});

test('serializes environment-specific host-only cookie contracts exactly', () => {
  const development = new CookieService('development');
  assert.equal(
    development.session('token', 60),
    'lcb_session=token; Max-Age=60; Path=/; HttpOnly; SameSite=Lax',
  );
  assert.equal(development.csrf('csrf', 60), 'lcb_csrf=csrf; Max-Age=60; Path=/; SameSite=Lax');

  const production = new CookieService('production');
  assert.equal(
    production.session('token', 60),
    '__Host-lcb_session=token; Max-Age=60; Path=/; HttpOnly; Secure; SameSite=Lax',
  );
  assert.deepEqual(production.clear(), [
    '__Host-lcb_session=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax',
    '__Host-lcb_csrf=; Max-Age=0; Path=/; Secure; SameSite=Lax',
  ]);
});
