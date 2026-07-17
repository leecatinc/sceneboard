import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AuthController, type AuthControllerService, type AuthHttpResponse } from '../../src/auth/auth.controller.js';
import { CookieService } from '../../src/auth/cookie.service.js';
import { CsrfService } from '../../src/auth/csrf.service.js';
import type { IssuedAuthSession } from '../../src/auth/auth.service.js';
import { SessionResolutionError, type SessionControllerService, type SessionRecord } from '../../src/auth/session.service.js';
import { AppError } from '../../src/common/errors/app-error.js';
import { CryptoService } from '../../src/common/security/crypto.service.js';
import { LogoutClearableError, type LogoutControllerService } from '../../src/auth/logout.service.js';
import { EmailVerificationService } from '../../src/auth/email-verification.service.js';
import { PasswordChangeService } from '../../src/auth/password-change.service.js';

const key = Buffer.alloc(32, 5);
const crypto = new CryptoService({
  sessionToken: key,
  grantToken: key,
  csrf: key,
  pairingCodePepper: key,
  auditHmac: key,
  rateLimitHmac: key,
}, (length) => Buffer.alloc(length, 6));

const captureResponse = () => {
  const headers = new Map<string, string | string[]>();
  const response: AuthHttpResponse = {
    setHeader(name, value) { headers.set(name, value); return response; },
    appendHeader(name, value) {
      const current = headers.get(name);
      headers.set(name, Array.isArray(current) ? [...current, value] : current === undefined ? [value] : [current, value]);
      return response;
    },
  };
  return { response, headers };
};

const issue: IssuedAuthSession = {
  response: {
    user: { userId: 'user_1' as IssuedAuthSession['response']['user']['userId'], email: 'User@Example.dev', createdAt: '2026-07-16T00:00:00.000Z' },
    session: {
      sessionId: 'session_1' as IssuedAuthSession['response']['session']['sessionId'],
      idleExpiresAt: '2026-07-16T08:00:00.000Z',
      absoluteExpiresAt: '2026-07-23T00:00:00.000Z',
    },
    csrfToken: 'lcbcsrf_v1.s.binding.nonce.expiry.mac',
  },
  sessionCredential: 'lcbs_v1.locator.secret',
  sessionMaxAgeSeconds: 604_800,
  csrfMaxAgeSeconds: 28_800,
  authGeneration: 'AAAAAAAAAAAAAAAAAAAAAA',
};

const activeSession: SessionRecord = {
  databaseId: '10',
  publicId: 'session_1',
  familyPublicId: 'family_1',
  tokenHash: Buffer.alloc(32),
  status: 'active',
  user: {
    databaseId: '20',
    publicId: 'user_1',
    email: 'User@Example.dev',
    status: 'active',
    createdAt: '2026-07-16T00:00:00.000Z',
  },
  idleExpiresAt: 1_800_028_800_000,
  absoluteExpiresAt: 1_800_604_800_000,
};

const unusedSessionResolver: SessionControllerService = {
  async resolveExclusive() { throw new Error('unexpected session resolution'); },
  async renew() { throw new Error('unexpected session renewal'); },
};

const unusedLogout: LogoutControllerService = {
  async logout() { throw new Error('unexpected logout'); },
};

const unusedEmailVerification = {
  async request() { throw new Error('unexpected email verification request'); },
  async confirm() { throw new Error('unexpected email verification confirmation'); },
  assertTicket() {},
} as unknown as EmailVerificationService;

const unusedPasswordChanges = {
  async change() { throw new Error('unexpected password change'); },
} as unknown as PasswordChangeService;

test('anonymous CSRF bootstrap emits only a CSRF cookie and generation proof', () => {
  const services: AuthControllerService = {
    async signup() { throw new Error('unexpected'); },
    async login() { throw new Error('unexpected'); },
  };
  const controller = new AuthController(services, unusedSessionResolver, new CsrfService(crypto), new CookieService('test'), unusedLogout, unusedEmailVerification, unusedPasswordChanges);
  const { response, headers } = captureResponse();
  const body = controller.csrf({ cookies: {} }, response, 1_800_000_000_000);
  assert.match(body.csrfToken, /^lcbcsrf_v1\.a\./);
  assert.equal((headers.get('Set-Cookie') as string[]).length, 1);
  assert.match(String((headers.get('Set-Cookie') as string[])[0]), /^lcb_test_csrf=/);
  assert.equal(headers.get('X-Auth-Generation')?.toString().length, 22);
  assert.equal(headers.get('Cache-Control'), 'no-store, private');
});

test('anonymous CSRF bootstrap rejects any existing session cookie without mutation', () => {
  const services: AuthControllerService = {
    async signup() { throw new Error('unexpected'); },
    async login() { throw new Error('unexpected'); },
  };
  const controller = new AuthController(services, unusedSessionResolver, new CsrfService(crypto), new CookieService('test'), unusedLogout, unusedEmailVerification, unusedPasswordChanges);
  const { response, headers } = captureResponse();
  assert.throws(() => controller.csrf({ cookies: { lcb_test_session: 'present' } }, response, 1_800_000_000_000), (error) => error instanceof AppError && error.code === 'AUTH_SESSION_PRESENT');
  assert.equal(headers.has('Set-Cookie'), false);
});

test('signup serializes session and CSRF cookies only after committed service success', async () => {
  const services: AuthControllerService = {
    async signup() { return issue; },
    async login() { throw new Error('unexpected'); },
  };
  const controller = new AuthController(services, unusedSessionResolver, new CsrfService(crypto), new CookieService('test'), unusedLogout, unusedEmailVerification, unusedPasswordChanges);
  const { response, headers } = captureResponse();
  const body = await controller.signup({
    email: 'User@Example.dev',
    password: 'correct horse battery staple',
    verificationTicket: `v1.${'x'.repeat(100)}`,
  }, response, 1_800_000_000_000);
  assert.deepEqual(body, issue.response);
  assert.deepEqual(headers.get('Set-Cookie'), [
    'lcb_test_session=lcbs_v1.locator.secret; Max-Age=604800; Path=/; HttpOnly; SameSite=Lax',
    'lcb_test_csrf=lcbcsrf_v1.s.binding.nonce.expiry.mac; Max-Age=28800; Path=/; SameSite=Lax',
  ]);
  assert.equal(headers.get('X-Auth-Generation'), issue.authGeneration);
});

test('password change uses the authenticated session without mutating current cookies', async () => {
  const services: AuthControllerService = {
    async signup() { throw new Error('unexpected'); },
    async login() { throw new Error('unexpected'); },
  };
  const calls: unknown[] = [];
  const passwordChanges = {
    async change(session: SessionRecord, input: unknown, now: number) {
      calls.push({ session, input, now });
    },
  } as unknown as PasswordChangeService;
  const controller = new AuthController(services, unusedSessionResolver, new CsrfService(crypto), new CookieService('test'), unusedLogout, unusedEmailVerification, passwordChanges);
  const { response, headers } = captureResponse();

  await controller.changePassword({
    currentPassword: 'current-password',
    newPassword: 'replacement-password',
  }, { headers: {}, cookies: {}, authSession: activeSession }, response, 1_800_000_000_000);

  assert.deepEqual(calls, [{
    session: activeSession,
    input: { currentPassword: 'current-password', newPassword: 'replacement-password' },
    now: 1_800_000_000_000,
  }]);
  assert.equal(headers.get('Cache-Control'), 'no-store, private');
  assert.equal(headers.has('Set-Cookie'), false);
  assert.equal(headers.has('X-Auth-Generation'), false);
});

test('session resolver clears cookies only for committed or safely unresolvable terminals', async () => {
  const services: AuthControllerService = {
    async signup() { throw new Error('unexpected'); },
    async login() { throw new Error('unexpected'); },
  };
  const terminal: SessionControllerService = {
    ...unusedSessionResolver,
    async resolveExclusive() { throw new SessionResolutionError('AUTH_SESSION_REUSED', true); },
  };
  const controller = new AuthController(services, terminal, new CsrfService(crypto), new CookieService('test'), unusedLogout, unusedEmailVerification, unusedPasswordChanges);
  const { response, headers } = captureResponse();
  await assert.rejects(() => controller.session({ cookies: { lcb_test_session: 'token' } }, response, 1_800_000_000_000));
  assert.deepEqual(headers.get('Set-Cookie'), new CookieService('test').clear());
  assert.equal(headers.get('X-Auth-Generation'), 'cleared');
});

test('session resolver preserves cookies when mandatory terminal audit rolls back', async () => {
  const services: AuthControllerService = {
    async signup() { throw new Error('unexpected'); },
    async login() { throw new Error('unexpected'); },
  };
  const unavailable: SessionControllerService = {
    ...unusedSessionResolver,
    async resolveExclusive() { throw new AppError('SERVICE_UNAVAILABLE'); },
  };
  const controller = new AuthController(services, unavailable, new CsrfService(crypto), new CookieService('test'), unusedLogout, unusedEmailVerification, unusedPasswordChanges);
  const { response, headers } = captureResponse();
  await assert.rejects(() => controller.session({ cookies: { lcb_test_session: 'token' } }, response, 1_800_000_000_000));
  assert.equal(headers.has('Set-Cookie'), false);
  assert.equal(headers.has('X-Auth-Generation'), false);
});

test('session renewal requires exact empty input and equal CSRF values before rotating cookies', async () => {
  const services: AuthControllerService = {
    async signup() { throw new Error('unexpected'); },
    async login() { throw new Error('unexpected'); },
  };
  const sessions: SessionControllerService = {
    ...unusedSessionResolver,
    async renew(credential, csrfToken) {
      assert.equal(credential, 'old-session');
      assert.equal(csrfToken, 'session-csrf');
      return issue;
    },
  };
  const controller = new AuthController(services, sessions, new CsrfService(crypto), new CookieService('test'), unusedLogout, unusedEmailVerification, unusedPasswordChanges);
  const { response, headers } = captureResponse();
  const body = await controller.renew({}, {
    cookies: { lcb_test_session: 'old-session', lcb_test_csrf: 'session-csrf' },
    headers: { 'x-csrf-token': 'session-csrf' },
  }, response, 1_800_000_000_000);
  assert.deepEqual(body, issue.response);
  assert.deepEqual(headers.get('Set-Cookie'), [
    'lcb_test_session=lcbs_v1.locator.secret; Max-Age=604800; Path=/; HttpOnly; SameSite=Lax',
    'lcb_test_csrf=lcbcsrf_v1.s.binding.nonce.expiry.mac; Max-Age=28800; Path=/; SameSite=Lax',
  ]);

  const rejected = captureResponse();
  await assert.rejects(() => controller.renew({ unexpected: true }, {
    cookies: { lcb_test_session: 'old-session', lcb_test_csrf: 'session-csrf' },
    headers: { 'x-csrf-token': 'session-csrf' },
  }, rejected.response), (error) => error instanceof AppError && error.code === 'INVALID_PAYLOAD');
  assert.equal(rejected.headers.has('Set-Cookie'), false);
});

test('session renewal clears cookies only after a committed terminal result', async () => {
  const services: AuthControllerService = {
    async signup() { throw new Error('unexpected'); },
    async login() { throw new Error('unexpected'); },
  };
  const terminal: SessionControllerService = {
    ...unusedSessionResolver,
    async renew() { throw new SessionResolutionError('AUTH_SESSION_REUSED', true); },
  };
  const controller = new AuthController(services, terminal, new CsrfService(crypto), new CookieService('test'), unusedLogout, unusedEmailVerification, unusedPasswordChanges);
  const { response, headers } = captureResponse();
  await assert.rejects(() => controller.renew({}, {
    cookies: { lcb_test_session: 'old-session', lcb_test_csrf: 'session-csrf' },
    headers: { 'x-csrf-token': 'session-csrf' },
  }, response));
  assert.deepEqual(headers.get('Set-Cookie'), new CookieService('test').clear());
  assert.equal(headers.get('X-Auth-Generation'), 'cleared');

  const unavailable: SessionControllerService = {
    ...unusedSessionResolver,
    async renew() { throw new AppError('SERVICE_UNAVAILABLE'); },
  };
  const unavailableController = new AuthController(services, unavailable, new CsrfService(crypto), new CookieService('test'), unusedLogout, unusedEmailVerification, unusedPasswordChanges);
  const unavailableResponse = captureResponse();
  await assert.rejects(() => unavailableController.renew({}, {
    cookies: { lcb_test_session: 'old-session', lcb_test_csrf: 'session-csrf' },
    headers: { 'x-csrf-token': 'session-csrf' },
  }, unavailableResponse.response));
  assert.equal(unavailableResponse.headers.has('Set-Cookie'), false);
});

test('logout clears cookies after success and after an already-terminal audit failure only', async () => {
  const services: AuthControllerService = {
    async signup() { throw new Error('unexpected'); },
    async login() { throw new Error('unexpected'); },
  };
  const logout: LogoutControllerService = {
    async logout(credential, csrfCookie, csrfHeader) {
      assert.equal(credential, 'session');
      assert.equal(csrfCookie, 'csrf');
      assert.equal(csrfHeader, 'csrf');
    },
  };
  const controller = new AuthController(services, unusedSessionResolver, new CsrfService(crypto), new CookieService('test'), logout, unusedEmailVerification, unusedPasswordChanges);
  const succeeded = captureResponse();
  await controller.logout({}, {
    cookies: { lcb_test_session: 'session', lcb_test_csrf: 'csrf' },
    headers: { 'x-csrf-token': 'csrf' },
  }, succeeded.response);
  assert.deepEqual(succeeded.headers.get('Set-Cookie'), new CookieService('test').clear());
  assert.equal(succeeded.headers.get('X-Auth-Generation'), 'cleared');

  const terminalAuditFailure: LogoutControllerService = {
    async logout() { throw new LogoutClearableError('SERVICE_UNAVAILABLE'); },
  };
  const terminalController = new AuthController(services, unusedSessionResolver, new CsrfService(crypto), new CookieService('test'), terminalAuditFailure, unusedEmailVerification, unusedPasswordChanges);
  const terminal = captureResponse();
  await assert.rejects(() => terminalController.logout({}, { cookies: {}, headers: {} }, terminal.response));
  assert.deepEqual(terminal.headers.get('Set-Cookie'), new CookieService('test').clear());

  const activeAuditFailure: LogoutControllerService = {
    async logout() { throw new AppError('SERVICE_UNAVAILABLE'); },
  };
  const activeController = new AuthController(services, unusedSessionResolver, new CsrfService(crypto), new CookieService('test'), activeAuditFailure, unusedEmailVerification, unusedPasswordChanges);
  const active = captureResponse();
  await assert.rejects(() => activeController.logout({}, { cookies: {}, headers: {} }, active.response));
  assert.equal(active.headers.has('Set-Cookie'), false);
});
