import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildMigrationConnectionProfile } from '../../src/database/migrations/certification-state.js';
import { createMysqlPoolOptions } from '../../src/database/mysql.service.js';
import { parseEnvironment } from '../../src/config/env.schema.js';

const key = 'A'.repeat(43);
const environment = parseEnvironment({
  APP_ENV: 'test',
  NODE_ENV: 'test',
  PORT: '3411',
  MYSQL_HOST: '127.0.0.1',
  MYSQL_PORT: '3306',
  MYSQL_USER: 'sceneboard',
  MYSQL_PASSWORD: 'secret',
  MYSQL_DATABASE: 'leecat_board',
  REDIS_HOST: '127.0.0.1',
  REDIS_PORT: '6379',
  REDIS_PASSWORD: 'secret',
  REDIS_DB: '0',
  REDIS_KEY_PREFIX: 'leecat_board:',
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

test('pins mysql2 safety options and never enables multi-statements', () => {
  const options = createMysqlPoolOptions(environment);
  assert.equal(options.charset, 'utf8mb4');
  assert.equal(options.timezone, 'Z');
  assert.equal(options.dateStrings, true);
  assert.equal(options.supportBigNumbers, true);
  assert.equal(options.bigNumberStrings, true);
  assert.equal(options.multipleStatements, false);
});

test('creates only the non-secret exact migration connection profile', () => {
  const profile = buildMigrationConnectionProfile({
    databaseIdentity: '127.0.0.1:3306/leecat_board/sceneboard',
    serverVersion: '8.0.44',
    timeZone: '+00:00',
    characterSet: 'utf8mb4',
    collation: 'utf8mb4_0900_ai_ci',
    sqlMode: 'ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION,STRICT_TRANS_TABLES',
  });
  assert.match(profile.databaseIdentitySha256, /^[a-f0-9]{64}$/);
  assert.match(profile.sqlModeSha256, /^[a-f0-9]{64}$/);
  assert.equal('password' in profile, false);
  assert.equal(profile.timeZone, '+00:00');
});
