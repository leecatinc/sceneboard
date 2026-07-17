import assert from 'node:assert/strict';
import { test } from 'node:test';

import { NestFactory } from '@nestjs/core';

import { AppModule } from '../../src/app.module.js';
import { AuthService } from '../../src/auth/auth.service.js';
import { APP_ENVIRONMENT, type AppEnvironment } from '../../src/config/env.schema.js';

const key = Buffer.alloc(32, 3).toString('base64url');

test('constructs the complete Nest dependency graph without opening a listener', async () => {
  Object.assign(process.env, {
    APP_ENV: 'test',
    NODE_ENV: 'test',
    PORT: '3411',
    MYSQL_HOST: '127.0.0.1',
    MYSQL_PORT: '3306',
    MYSQL_USER: 'sceneboard_test',
    MYSQL_PASSWORD: 'not-a-real-secret',
    MYSQL_DATABASE: 'leecat_board',
    REDIS_HOST: '127.0.0.1',
    REDIS_PORT: '6379',
    REDIS_PASSWORD: 'not-a-real-secret',
    REDIS_DB: '15',
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
  const context = await NestFactory.createApplicationContext(AppModule, { logger: ['error'], abortOnError: false });
  try {
    assert.equal(context.get<AppEnvironment>(APP_ENVIRONMENT).appEnv, 'test');
    assert.ok(context.get(AuthService));
  } finally {
    await context.close();
  }
});
