import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  EnvironmentValidationError,
  parseEnvironment,
  parsePersistenceEnvironment,
} from '../../src/config/env.schema.js';

const key = 'A'.repeat(43);

const validEnvironment = (): Record<string, string> => ({
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

test('parses the exact development environment and canonical same-host origins', () => {
  const environment = parseEnvironment(validEnvironment());
  assert.equal(environment.port, 3411);
  assert.equal(environment.mysql.database, 'sceneboard');
  assert.equal(environment.redis.keyPrefix, 'sceneboard:');
  assert.equal(environment.gmail.user, 'sceneboard@example.com');
  assert.equal(environment.browserOrigin, 'http://127.0.0.1:3410');
  assert.equal(environment.publicApiOrigin, 'http://127.0.0.1:3411');
  assert.equal(environment.keys.sessionToken.byteLength, 32);
  assert.equal(environment.streamKeyMaterial.byteLength, 32);
});

test('parses persistence settings without requiring unrelated application secrets', () => {
  const input = validEnvironment();
  const persistence = parsePersistenceEnvironment(
    Object.fromEntries(
      Object.entries(input).filter(
        ([keyName]) => keyName.startsWith('MYSQL_') || keyName.startsWith('REDIS_'),
      ),
    ),
  );
  assert.equal(persistence.mysql.database, 'sceneboard');
  assert.equal(persistence.redis.keyPrefix, 'sceneboard:');
});

test('rejects non-canonical, multi-origin, different-host, insecure production, and placeholder values', () => {
  const invalid: Array<[string, Partial<Record<string, string>>]> = [
    ['trailing slash', { BOARD_ALLOWED_ORIGINS: 'http://127.0.0.1:3410/' }],
    ['origin list', { BOARD_ALLOWED_ORIGINS: 'http://127.0.0.1:3410,http://127.0.0.2:3412' }],
    ['different host', { BOARD_PUBLIC_API_ORIGIN: 'http://localhost:3411' }],
    ['placeholder', { MYSQL_PASSWORD: '<set-by-secret>' }],
    ['gmail placeholder', { SCENEBOARD_GMAIL_APP_PASSWORD: '<set-by-secret>' }],
    ['short key', { SESSION_TOKEN_KEY_B64: 'abc' }],
    ['stream base64url', { BOARD_STREAM_KEY_B64: key }],
    ['staging node mode', { APP_ENV: 'staging', NODE_ENV: 'development' }],
    ['insecure production', { APP_ENV: 'production', NODE_ENV: 'production' }],
  ];
  for (const [label, patch] of invalid) {
    assert.throws(
      () => parseEnvironment({ ...validEnvironment(), ...patch }),
      EnvironmentValidationError,
      label,
    );
  }
});

test('accepts canonical HTTPS production origins on one hostname', () => {
  const environment = parseEnvironment({
    ...validEnvironment(),
    APP_ENV: 'production',
    NODE_ENV: 'production',
    BOARD_ALLOWED_ORIGINS: 'https://sceneboard.dev',
    BOARD_PUBLIC_API_ORIGIN: 'https://sceneboard.dev:3411',
  });
  assert.equal(environment.appEnv, 'production');
});
