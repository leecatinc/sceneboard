import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

import { CryptoService } from '../../src/common/security/crypto.service.js';
import { parseEnvironment } from '../../src/config/env.schema.js';
import { ShareContractError } from '../../src/common/errors/app-error.js';
import { ShareCookieService } from '../../src/shares/share-cookie.service.js';

const key = 'A'.repeat(43);
const environment = () =>
  parseEnvironment({
    APP_ENV: 'development',
    NODE_ENV: 'development',
    PORT: '3411',
    MYSQL_HOST: '127.0.0.1',
    MYSQL_PORT: '3306',
    MYSQL_USER: 'sceneboard',
    MYSQL_PASSWORD: 'development-secret',
    MYSQL_DATABASE: 'sceneboard',
    REDIS_HOST: '127.0.0.1',
    REDIS_PORT: '6379',
    REDIS_PASSWORD: 'development-secret',
    REDIS_DB: '0',
    REDIS_KEY_PREFIX: 'sceneboard:',
    SCENEBOARD_GMAIL_USER: 'sceneboard@example.com',
    SCENEBOARD_GMAIL_APP_PASSWORD: 'test-app-password',
    SESSION_TOKEN_KEY_B64: key,
    GRANT_TOKEN_KEY_B64: key,
    CSRF_KEY_B64: key,
    PAIRING_CODE_PEPPER_B64: key,
    AUDIT_HMAC_KEY_B64: key,
    RATE_LIMIT_HMAC_KEY_B64: key,
    BOARD_CURSOR_MAC_KEY_B64: key,
    BOARD_STREAM_KEY_B64: Buffer.alloc(32, 9).toString('base64'),
    BCRYPT_COST: '12',
    AUTH_FAILURE_MIN_MS: '500',
    AUTH_FAILURE_JITTER_MS: '20',
    PAIRING_FAILURE_MIN_MS: '100',
    PAIRING_FAILURE_JITTER_MS: '20',
    BOARD_ALLOWED_ORIGINS: 'http://127.0.0.1:3410',
    BOARD_PUBLIC_API_ORIGIN: 'http://127.0.0.1:3411',
    TRUSTED_PROXY_CIDRS: '',
  });

const service = () => {
  const material = Buffer.alloc(32, 4);
  return new ShareCookieService(
    environment(),
    new CryptoService(
      {
        sessionToken: material,
        grantToken: material,
        csrf: material,
        pairingCodePepper: material,
        auditHmac: material,
        rateLimitHmac: material,
      },
      (length) => Buffer.alloc(length, 13),
    ),
  );
};

test('isolates family and CSRF cookies with exact loopback attributes', () => {
  const cookies = service();
  const csrf = cookies.ensureShareCsrfCookie({
    hostname: '127.0.0.1',
    nowSeconds: 2_000_000_000,
  });
  assert.match(
    csrf.setCookie!,
    /^sceneboard_share_csrf_dev=.+; Max-Age=1800; Path=\/; SameSite=Lax$/u,
  );
  cookies.assertCsrf({
    hostname: '127.0.0.1',
    cookieHeader: `sceneboard_share_csrf_dev=${csrf.csrfToken}; lcb_session=ambient`,
    header: csrf.csrfToken,
    nowSeconds: 2_000_000_001,
  });
  const family = cookies.issueFamily('127.0.0.1');
  assert.match(
    family.setCookie,
    /^sceneboard_share_dev=.+; Max-Age=1800; Path=\/; HttpOnly; SameSite=Lax$/u,
  );
  assert.equal(
    cookies.familyFromHeader(`sceneboard_share_dev=${family.token}`, '127.0.0.1'),
    family.token,
  );
  assert.deepEqual(family.digest, createHash('sha256').update(family.token, 'ascii').digest());
});

test('rotates CSRF at 900 seconds and rejects duplicate or unequal values generically', () => {
  const cookies = service();
  const issued = cookies.ensureShareCsrfCookie({
    hostname: '127.0.0.1',
    nowSeconds: 2_000_000_000,
  });
  const rotated = cookies.ensureShareCsrfCookie({
    hostname: '127.0.0.1',
    cookieHeader: `sceneboard_share_csrf_dev=${issued.csrfToken}`,
    nowSeconds: 2_000_000_900,
  });
  assert.notEqual(rotated.setCookie, null);
  assert.throws(
    () =>
      cookies.assertCsrf({
        hostname: '127.0.0.1',
        cookieHeader: `sceneboard_share_csrf_dev=${issued.csrfToken}; sceneboard_share_csrf_dev=${issued.csrfToken}`,
        header: issued.csrfToken,
        nowSeconds: 2_000_000_001,
      }),
    (error: unknown) => error instanceof ShareContractError && error.reason === 'csrf',
  );
});
