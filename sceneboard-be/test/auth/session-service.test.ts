import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  SessionResolutionError,
  SessionService,
  type SessionPersistence,
  type SessionRecord,
} from '../../src/auth/session.service.js';
import { CsrfService } from '../../src/auth/csrf.service.js';
import { SessionTokenService } from '../../src/auth/session-token.service.js';
import { AppError } from '../../src/common/errors/app-error.js';
import { CryptoService } from '../../src/common/security/crypto.service.js';
import type { RateLimitService } from '../../src/rate-limit/rate-limit.service.js';

const key = Buffer.alloc(32, 2);

const setup = (
  status: SessionRecord['status'] = 'active',
  overrides: Partial<SessionRecord> = {},
) => {
  let random = 1;
  const crypto = new CryptoService(
    {
      sessionToken: key,
      grantToken: key,
      csrf: key,
      pairingCodePepper: key,
      auditHmac: key,
      rateLimitHmac: key,
    },
    (length) => Buffer.alloc(length, random++),
  );
  const tokens = new SessionTokenService(crypto);
  const issued = tokens.issue();
  const record: SessionRecord = {
    databaseId: '1',
    publicId: 'session_1',
    familyPublicId: 'family_1',
    tokenHash: issued.tokenHash,
    status,
    user: {
      databaseId: '2',
      publicId: 'user_1',
      email: 'User@Example.dev',
      status: 'active',
      createdAt: '2026-07-16T00:00:00.000Z',
    },
    idleExpiresAt: 1_800_028_800_000,
    absoluteExpiresAt: 1_800_604_800_000,
    ...overrides,
  };
  const cascades: string[] = [];
  const persistence: SessionPersistence = {
    async findByLocator() {
      return record;
    },
    async terminalizeFamily(_record, reason) {
      cascades.push(reason);
      return { kind: 'committed' };
    },
    async rotate() {
      throw new Error('unexpected rotation');
    },
    async observeLogout() {
      throw new Error('unexpected logout observation');
    },
  };
  return { crypto, tokens, issued, record, cascades, persistence };
};

test('resolves an active credential from MySQL and reissues only a family-bound CSRF token', async () => {
  const value = setup();
  const service = new SessionService(
    value.persistence,
    value.tokens,
    new CsrfService(value.crypto),
    value.crypto,
  );
  const result = await service.resolveExclusive(value.issued.token, undefined, 1_800_000_000_000);
  assert.equal(result.response.user.userId, 'user_1');
  assert.equal(result.response.session.sessionId, 'session_1');
  assert.match(result.response.csrfToken, /^lcbcsrf_v1\.s\./);
  assert.equal(result.csrfWasReissued, true);
  assert.deepEqual(value.cascades, []);
});

test('never promotes malformed, unknown, or bad-HMAC credentials to destructive reuse', async () => {
  const value = setup('rotated');
  const persistence: SessionPersistence = {
    ...value.persistence,
    async findByLocator(locator) {
      return locator.equals(value.issued.locator) ? value.record : null;
    },
  };
  const service = new SessionService(
    persistence,
    value.tokens,
    new CsrfService(value.crypto),
    value.crypto,
  );
  for (const token of ['malformed', value.issued.token.replace(/.$/, 'A')]) {
    await assert.rejects(
      () => service.resolveExclusive(token, undefined, 1_800_000_000_000),
      (error) =>
        error instanceof SessionResolutionError &&
        error.code === 'UNAUTHENTICATED' &&
        error.clearCookies,
    );
  }
  assert.deepEqual(value.cascades, []);
});

test('verified rotated, expired, and disabled rows commit the mandatory family cascade first', async () => {
  const cases = [
    {
      status: 'rotated' as const,
      override: {},
      reason: 'reuse' as const,
      code: 'AUTH_SESSION_REUSED',
    },
    {
      status: 'active' as const,
      override: { idleExpiresAt: 1_799_999_999_999 },
      reason: 'expired' as const,
      code: 'AUTH_SESSION_EXPIRED',
    },
    {
      status: 'active' as const,
      override: {
        user: {
          databaseId: '2',
          publicId: 'user_1',
          email: 'User@Example.dev',
          status: 'disabled' as const,
          createdAt: '2026-07-16T00:00:00.000Z',
        },
      },
      reason: 'disabled' as const,
      code: 'AUTH_SESSION_REVOKED',
    },
  ];
  for (const item of cases) {
    const value = setup(item.status, item.override);
    const service = new SessionService(
      value.persistence,
      value.tokens,
      new CsrfService(value.crypto),
      value.crypto,
    );
    await assert.rejects(
      () => service.resolveExclusive(value.issued.token, undefined, 1_800_000_000_000),
      (error) =>
        error instanceof SessionResolutionError && error.code === item.code && error.clearCookies,
    );
    assert.deepEqual(value.cascades, [item.reason]);
  }
});

test('mandatory cascade failure returns retryable 503 and preserves cookies', async () => {
  const value = setup('rotated');
  const persistence: SessionPersistence = {
    ...value.persistence,
    async terminalizeFamily() {
      return { kind: 'audit_failed' };
    },
  };
  const service = new SessionService(
    persistence,
    value.tokens,
    new CsrfService(value.crypto),
    value.crypto,
  );
  await assert.rejects(
    () => service.resolveExclusive(value.issued.token, undefined, 1_800_000_000_000),
    (error) =>
      error instanceof AppError &&
      error.code === 'SERVICE_UNAVAILABLE' &&
      (!(error instanceof SessionResolutionError) || !error.clearCookies),
  );
});

test('renews by rotating the verified row and returns a different opaque credential and CSRF generation', async () => {
  const value = setup();
  let captured: Parameters<SessionPersistence['rotate']>[1] | undefined;
  const persistence: SessionPersistence = {
    ...value.persistence,
    async rotate(_record, replacement) {
      captured = replacement;
      return { kind: 'created' };
    },
  };
  const csrf = new CsrfService(value.crypto);
  const currentCsrf = csrf.issueSession(
    value.record.familyPublicId,
    1_800_000_000_000,
    value.record.idleExpiresAt,
  ).token;
  const service = new SessionService(persistence, value.tokens, csrf, value.crypto);
  const renewed = await service.renew(value.issued.token, currentCsrf, 1_800_000_000_000);
  assert.notEqual(renewed.sessionCredential, value.issued.token);
  assert.equal(captured?.familyPublicId, value.record.familyPublicId);
  assert.equal(captured?.tokenHash.byteLength, 32);
  assert.equal('token' in (captured ?? {}), false);
  assert.match(renewed.response.csrfToken, /^lcbcsrf_v1\.s\./);
});

test('renewal consumes the resolved session bucket after valid CSRF and before rotation', async () => {
  const value = setup();
  const order: string[] = [];
  const persistence: SessionPersistence = {
    ...value.persistence,
    async rotate() {
      order.push('rotate');
      return { kind: 'created' };
    },
  };
  const limiter = {
    async consume(input: {
      surface: string;
      purpose: string;
      identity: string;
      limit: number;
      windowMs: number;
    }) {
      order.push('limit');
      assert.deepEqual(input, {
        surface: 'session-renewal-session',
        purpose: 'rate-limit-session/v1',
        identity: 'session_1',
        limit: 30,
        windowMs: 300_000,
      });
    },
  } as RateLimitService;
  const csrf = new CsrfService(value.crypto);
  const currentCsrf = csrf.issueSession(
    value.record.familyPublicId,
    1_800_000_000_000,
    value.record.idleExpiresAt,
  ).token;
  const service = new SessionService(persistence, value.tokens, csrf, value.crypto, limiter);
  await service.renew(value.issued.token, currentCsrf, 1_800_000_000_000);
  assert.deepEqual(order, ['limit', 'rotate']);
});

test('renewal does not consume the resolved-session bucket for invalid CSRF', async () => {
  const value = setup();
  let consumed = false;
  const limiter = {
    async consume(_input: Parameters<RateLimitService['consume']>[0]) {
      consumed = true;
    },
  } as RateLimitService;
  const service = new SessionService(
    value.persistence,
    value.tokens,
    new CsrfService(value.crypto),
    value.crypto,
    limiter,
  );
  await assert.rejects(
    () => service.renew(value.issued.token, 'invalid', 1_800_000_000_000),
    (error) => error instanceof AppError && error.code === 'CSRF_INVALID',
  );
  assert.equal(consumed, false);
});

test('a renewal loser terminalizes verified old-token reuse before returning AUTH_SESSION_REUSED', async () => {
  const value = setup();
  const persistence: SessionPersistence = {
    ...value.persistence,
    async rotate() {
      return { kind: 'already_rotated' };
    },
  };
  const csrf = new CsrfService(value.crypto);
  const currentCsrf = csrf.issueSession(
    value.record.familyPublicId,
    1_800_000_000_000,
    value.record.idleExpiresAt,
  ).token;
  const service = new SessionService(persistence, value.tokens, csrf, value.crypto);
  await assert.rejects(
    () => service.renew(value.issued.token, currentCsrf, 1_800_000_000_000),
    (error) =>
      error instanceof SessionResolutionError &&
      error.code === 'AUTH_SESSION_REUSED' &&
      error.clearCookies,
  );
  assert.deepEqual(value.cascades, ['reuse']);
});
