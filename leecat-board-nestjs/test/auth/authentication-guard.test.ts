import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';

import { CookieService } from '../../src/auth/cookie.service.js';
import type { SessionRecord, SessionService } from '../../src/auth/session.service.js';
import { AuthenticationGuard, type AuthenticatedRequest } from '../../src/common/guards/authentication.guard.js';
import { AppError } from '../../src/common/errors/app-error.js';

const record = { familyPublicId: 'family_1' } as SessionRecord;

const context = (request: AuthenticatedRequest): ExecutionContext => ({
  getHandler: () => function handler() {},
  getClass: () => class Controller {},
  switchToHttp: () => ({ getRequest: () => request }),
}) as unknown as ExecutionContext;

test('session guard resolves one cookie principal and rejects an ambiguous authorization header', async () => {
  let calls = 0;
  const reflector = { getAllAndOverride: () => true } as unknown as Reflector;
  const sessions = {
    async resolveShared(credential: string | undefined) {
      calls += 1;
      assert.equal(credential, 'session-token');
      return record;
    },
  } as unknown as SessionService;
  const guard = new AuthenticationGuard(reflector, sessions, new CookieService('test'));
  const request: AuthenticatedRequest = {
    headers: {},
    cookies: { lcb_test_session: 'session-token' },
  };
  assert.equal(await guard.canActivate(context(request)), true);
  assert.equal(request.authSession, record);

  await assert.rejects(() => guard.canActivate(context({
    headers: { authorization: 'Bearer grant' },
    cookies: { lcb_test_session: 'session-token' },
  })), (error) => error instanceof AppError && error.code === 'UNAUTHENTICATED');
  assert.equal(calls, 1);
});
