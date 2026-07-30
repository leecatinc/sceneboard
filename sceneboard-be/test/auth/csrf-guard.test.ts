import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';

import { assertOriginAndCsrf } from '../../src/common/guards/csrf.guard.js';
import { CsrfGuard } from '../../src/common/guards/csrf.guard.js';
import { CookieService } from '../../src/auth/cookie.service.js';
import { CsrfService } from '../../src/auth/csrf.service.js';
import { AppError } from '../../src/common/errors/app-error.js';
import { CryptoService } from '../../src/common/security/crypto.service.js';
import type { AppEnvironment } from '../../src/config/env.schema.js';
import type { ResolvedBoardPrincipalV1 } from '../../src/grants/board-access.policy.js';

const key = Buffer.alloc(32, 8);
const crypto = new CryptoService({
  sessionToken: key,
  grantToken: key,
  csrf: key,
  pairingCodePepper: key,
  auditHmac: key,
  rateLimitHmac: key,
});

test('requires exact Origin plus equal anonymous cookie/header before verification', () => {
  const csrf = new CsrfService(crypto);
  const issued = csrf.issueAnonymous(1_800_000_000_000);
  const cookies = new CookieService('test');
  assert.doesNotThrow(() =>
    assertOriginAndCsrf({
      requiredKind: 'anonymous',
      allowedOrigin: 'http://127.0.0.1:3410',
      origin: 'http://127.0.0.1:3410',
      csrfCookie: issued.token,
      csrfHeader: issued.token,
      now: 1_800_000_000_000,
      csrf,
      cookies,
    }),
  );

  for (const mutation of [
    { origin: 'http://localhost:3410' },
    { csrfCookie: undefined },
    { csrfHeader: `${issued.token}x` },
  ]) {
    assert.throws(
      () =>
        assertOriginAndCsrf({
          requiredKind: 'anonymous',
          allowedOrigin: 'http://127.0.0.1:3410',
          origin: 'http://127.0.0.1:3410',
          csrfCookie: issued.token,
          csrfHeader: issued.token,
          now: 1_800_000_000_000,
          csrf,
          cookies,
          ...mutation,
        }),
      (error) => error instanceof AppError && error.code === 'CSRF_INVALID',
    );
  }
});

test('bypasses browser CSRF only for a resolved bearer principal', () => {
  const request = {
    headers: {},
    cookies: {},
    boardPrincipal: {
      kind: 'account_api_key',
      isBrowserCredential: false,
    } as ResolvedBoardPrincipalV1,
  };
  const context = {
    getHandler: () => 'handler',
    getClass: () => 'controller',
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
  const reflector = {
    getAllAndOverride: () => 'session',
  } as unknown as Reflector;
  const rejectingCsrf = {
    constantTimeEqual() {
      throw new Error('must not evaluate browser CSRF');
    },
  } as unknown as CsrfService;
  const guard = new CsrfGuard(
    reflector,
    { browserOrigin: 'https://browser.example' } as AppEnvironment,
    rejectingCsrf,
    new CookieService('test'),
  );
  assert.equal(guard.canActivate(context), true);
});
