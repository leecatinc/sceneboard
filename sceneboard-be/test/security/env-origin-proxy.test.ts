import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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
  assert.equal(environment.revisionRetentionCount, 32);
  assert.equal(environment.historyRetainedEmissionEnabled, false);
  assert.equal(environment.revisionReclamationEnabled, false);
  assert.equal(environment.accountApiKeyIssuanceEnabled, false);
  assert.equal(environment.accountApiKeyAuthEnabled, false);
  assert.equal(environment.boardDocumentV3WriteEnabled, false);
});

test('accepts only exact lowercase feature booleans', () => {
  const enabled = parseEnvironment({
    ...validEnvironment(),
    HISTORY_RETAINED_EMISSION_ENABLED: 'true',
    REVISION_RECLAMATION_ENABLED: 'true',
    ACCOUNT_API_KEY_ISSUANCE_ENABLED: 'true',
    ACCOUNT_API_KEY_AUTH_ENABLED: 'true',
    BOARD_DOCUMENT_V3_WRITE_ENABLED: 'true',
  });
  assert.equal(enabled.historyRetainedEmissionEnabled, true);
  assert.equal(enabled.revisionReclamationEnabled, true);
  assert.equal(enabled.accountApiKeyIssuanceEnabled, true);
  assert.equal(enabled.accountApiKeyAuthEnabled, true);
  assert.equal(enabled.boardDocumentV3WriteEnabled, true);

  for (const keyName of [
    'HISTORY_RETAINED_EMISSION_ENABLED',
    'REVISION_RECLAMATION_ENABLED',
    'ACCOUNT_API_KEY_ISSUANCE_ENABLED',
    'ACCOUNT_API_KEY_AUTH_ENABLED',
    'BOARD_DOCUMENT_V3_WRITE_ENABLED',
  ] as const) {
    for (const source of ['TRUE', '1', 'yes', ' true', 'false ']) {
      assert.throws(
        () => parseEnvironment({ ...validEnvironment(), [keyName]: source }),
        EnvironmentValidationError,
      );
    }
  }
});

test('accepts only canonical retention counts from 1 through 256', () => {
  for (const [source, expected] of [
    ['1', 1],
    ['32', 32],
    ['256', 256],
  ] as const) {
    assert.equal(
      parseEnvironment({ ...validEnvironment(), REVISION_RETENTION_COUNT: source })
        .revisionRetentionCount,
      expected,
    );
  }
  for (const source of ['0', '257', '01', '+1', '1.0', ' 32', '32 ']) {
    assert.throws(
      () => parseEnvironment({ ...validEnvironment(), REVISION_RETENTION_COUNT: source }),
      EnvironmentValidationError,
    );
  }
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

test('admits only an exact test-owned disposable certification database', () => {
  const attemptId = 'attempt-browser-001';
  const purpose = 'browser';
  const fixtureAttemptId = `${attemptId}.${purpose}`;
  const database = `sceneboard_cert_${createHash('sha256')
    .update(fixtureAttemptId)
    .digest('hex')
    .slice(0, 20)}`;
  const ownerSha256 = createHash('sha256')
    .update(`sceneboard-certification-database:${fixtureAttemptId}`)
    .digest('hex');
  const disposable = {
    ...validEnvironment(),
    APP_ENV: 'test',
    NODE_ENV: 'test',
    MYSQL_DATABASE: database,
    SCENEBOARD_CERTIFICATION_DISPOSABLE_DATABASE: 'true',
    SCENEBOARD_CERTIFICATION_ATTEMPT_ID: attemptId,
    SCENEBOARD_CERTIFICATION_DATABASE_PURPOSE: purpose,
    SCENEBOARD_CERTIFICATION_DATABASE_OWNER_SHA256: ownerSha256,
  };
  assert.equal(parseEnvironment(disposable).mysql.database, database);

  for (const [label, patch] of [
    ['non-test application', { APP_ENV: 'development' }],
    ['non-test node process', { NODE_ENV: 'development' }],
    ['false disposable gate', { SCENEBOARD_CERTIFICATION_DISPOSABLE_DATABASE: 'false' }],
    ['missing attempt', { SCENEBOARD_CERTIFICATION_ATTEMPT_ID: undefined }],
    ['unsafe attempt', { SCENEBOARD_CERTIFICATION_ATTEMPT_ID: '../attempt' }],
    ['unknown purpose', { SCENEBOARD_CERTIFICATION_DATABASE_PURPOSE: 'release' }],
    ['default database', { MYSQL_DATABASE: 'sceneboard' }],
    ['mismatched database', { MYSQL_DATABASE: 'sceneboard_cert_00000000000000000000' }],
    ['mismatched owner', { SCENEBOARD_CERTIFICATION_DATABASE_OWNER_SHA256: '0'.repeat(64) }],
  ] as const) {
    assert.throws(
      () => parseEnvironment({ ...disposable, ...patch }),
      EnvironmentValidationError,
      label,
    );
  }
  assert.throws(
    () =>
      parseEnvironment({
        ...validEnvironment(),
        MYSQL_DATABASE: database,
      }),
    EnvironmentValidationError,
    'derived database without the disposable gate',
  );
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
