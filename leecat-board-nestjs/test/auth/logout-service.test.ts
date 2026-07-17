import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CsrfService } from '../../src/auth/csrf.service.js';
import { LogoutClearableError, LogoutService } from '../../src/auth/logout.service.js';
import { SessionResolutionError, type SessionPersistence, type SessionRecord } from '../../src/auth/session.service.js';
import { SessionTokenService } from '../../src/auth/session-token.service.js';
import { AppError } from '../../src/common/errors/app-error.js';
import { CryptoService } from '../../src/common/security/crypto.service.js';

const now = 1_800_000_000_000;
const key = Buffer.alloc(32, 9);

const setup = (overrides: Partial<SessionRecord> = {}) => {
  const crypto = new CryptoService({
    sessionToken: key,
    grantToken: key,
    csrf: key,
    pairingCodePepper: key,
    auditHmac: key,
    rateLimitHmac: key,
  }, (length) => Buffer.alloc(length, 10));
  const tokens = new SessionTokenService(crypto);
  const issued = tokens.issue();
  const record: SessionRecord = {
    databaseId: '1',
    publicId: 'session_1',
    familyPublicId: 'family_1',
    tokenHash: issued.tokenHash,
    status: 'active',
    user: {
      databaseId: '2',
      publicId: 'user_1',
      email: 'User@Example.dev',
      status: 'active',
      createdAt: '2026-07-16T00:00:00.000Z',
    },
    idleExpiresAt: now + 28_800_000,
    absoluteExpiresAt: now + 604_800_000,
    ...overrides,
  };
  const calls: string[] = [];
  const persistence: SessionPersistence = {
    async findByLocator() { calls.push('find'); return record; },
    async terminalizeFamily(_record, reason) { calls.push(`terminal:${reason}`); return { kind: 'committed' }; },
    async rotate() { throw new Error('unexpected'); },
    async observeLogout() { calls.push('observe'); return { kind: 'committed' }; },
  };
  const csrf = new CsrfService(crypto);
  return { tokens, issued, record, persistence, csrf, calls };
};

test('logout permits a truly empty anonymous state and validates optional signature-only CSRF', async () => {
  const value = setup();
  const service = new LogoutService(value.persistence, value.tokens, value.csrf);
  await service.logout(undefined, undefined, undefined, now);
  assert.deepEqual(value.calls, []);

  const anonymous = value.csrf.issueAnonymous(now).token;
  await service.logout(undefined, anonymous, anonymous, now);
  assert.deepEqual(value.calls, []);
  await assert.rejects(
    () => service.logout(undefined, anonymous, `${anonymous}x`, now),
    (error) => error instanceof AppError && error.code === 'CSRF_INVALID',
  );
});

test('logout safely accepts malformed and unknown credentials only after signature validation', async () => {
  const value = setup();
  const anonymous = value.csrf.issueAnonymous(now).token;
  const service = new LogoutService({
    ...value.persistence,
    async findByLocator() { value.calls.push('find'); return null; },
  }, value.tokens, value.csrf);
  await assert.rejects(() => service.logout('malformed', undefined, undefined, now), AppError);
  await service.logout('malformed', anonymous, anonymous, now);
  await service.logout(value.issued.token, anonymous, anonymous, now);
  assert.deepEqual(value.calls, ['find']);
});

test('logout terminalizes active, disabled, and rotated verified families with mandatory audit semantics', async () => {
  for (const item of [
    { overrides: {}, reason: 'logout', error: null },
    { overrides: { user: { databaseId: '2', publicId: 'user_1', email: 'User@Example.dev', status: 'disabled' as const, createdAt: '2026-07-16T00:00:00.000Z' } }, reason: 'disabled', error: null },
    { overrides: { status: 'rotated' as const }, reason: 'reuse', error: 'AUTH_SESSION_REUSED' },
  ]) {
    const value = setup(item.overrides);
    const csrf = value.csrf.issueSession(value.record.familyPublicId, now, value.record.idleExpiresAt).token;
    const service = new LogoutService(value.persistence, value.tokens, value.csrf);
    if (item.error === null) await service.logout(value.issued.token, csrf, csrf, now);
    else await assert.rejects(
      () => service.logout(value.issued.token, csrf, csrf, now),
      (error) => error instanceof SessionResolutionError && error.code === item.error && error.clearCookies,
    );
    assert.deepEqual(value.calls, ['find', `terminal:${item.reason}`]);
  }
});

test('logout rejects expired CSRF before session lookup and preserves active cookies on cascade rollback', async () => {
  const value = setup();
  const expiredCsrf = value.csrf.issueSession(value.record.familyPublicId, now - 28_800_001, now - 1).token;
  const service = new LogoutService(value.persistence, value.tokens, value.csrf);
  await assert.rejects(
    () => service.logout(value.issued.token, expiredCsrf, expiredCsrf, now),
    (error) => error instanceof AppError && error.code === 'CSRF_INVALID',
  );
  assert.deepEqual(value.calls, []);

  const liveCsrf = value.csrf.issueSession(value.record.familyPublicId, now, value.record.idleExpiresAt).token;
  const unavailable = new LogoutService({
    ...value.persistence,
    async terminalizeFamily() { return { kind: 'audit_failed' }; },
  }, value.tokens, value.csrf);
  await assert.rejects(
    () => unavailable.logout(value.issued.token, liveCsrf, liveCsrf, now),
    (error) => error instanceof AppError && error.code === 'SERVICE_UNAVAILABLE' && !(error instanceof LogoutClearableError),
  );
});

test('already-revoked logout clears even when its idempotent success audit fails', async () => {
  const value = setup({ status: 'revoked' });
  const csrf = value.csrf.issueSession(value.record.familyPublicId, now, value.record.idleExpiresAt).token;
  const service = new LogoutService({
    ...value.persistence,
    async observeLogout() { return { kind: 'audit_failed' }; },
  }, value.tokens, value.csrf);
  await assert.rejects(
    () => service.logout(value.issued.token, csrf, csrf, now),
    (error) => error instanceof LogoutClearableError && error.code === 'SERVICE_UNAVAILABLE',
  );
});
