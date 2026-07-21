import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { SessionRecord } from '../../src/auth/session.service.js';
import { AppError } from '../../src/common/errors/app-error.js';
import { CryptoService } from '../../src/common/security/crypto.service.js';
import { GrantCursorService } from '../../src/grants/grant-cursor.service.js';
import type { GrantRepository } from '../../src/grants/grant.repository.js';
import { GrantService } from '../../src/grants/grant.service.js';
import type { GrantSummary } from '../../src/grants/grant.status.js';
import { GrantTokenService } from '../../src/grants/grant-token.service.js';

const key = Buffer.alloc(32, 8);
const crypto = new CryptoService(
  {
    sessionToken: key,
    grantToken: key,
    csrf: key,
    pairingCodePepper: key,
    auditHmac: key,
    rateLimitHmac: key,
  },
  (length) => Buffer.alloc(length, 12),
);
const session = {
  publicId: 'session_1',
  user: { databaseId: '1', publicId: 'user_1' },
} as SessionRecord;
const summary = {
  grantId: 'grant_1',
  status: 'active',
  activatedAt: '2027-01-15T08:00:00.000Z',
} as GrantSummary;

test('grant list returns only summaries and an owner-bound opaque next cursor', async () => {
  const repository = {
    async list() {
      return {
        grants: [summary],
        nextTuple: { createdAt: '2027-01-15T08:00:00.000Z', id: '42' },
      };
    },
  } as unknown as GrantRepository;
  const service = new GrantService(
    repository,
    new GrantCursorService(crypto),
    new GrantTokenService(crypto),
  );
  const response = await service.list(session, { cursor: null, limit: 25 }, 1_800_000_000_000);
  assert.equal(response.grants[0], summary);
  assert.match(response.nextCursor ?? '', /^lcgc_v1\./);
  assert.equal(JSON.stringify(response).includes('accessToken'), false);
});

test('grant rotation persists only the new locator/digest and returns its raw token once', async () => {
  let captured: Parameters<GrantRepository['rotate']>[0] | undefined;
  const repository = {
    async rotate(input: Parameters<GrantRepository['rotate']>[0]) {
      captured = input;
      return { kind: 'rotated' as const, grant: summary };
    },
  } as unknown as GrantRepository;
  const service = new GrantService(
    repository,
    new GrantCursorService(crypto),
    new GrantTokenService(crypto),
  );
  const response = await service.rotate(session, 'grant_1', 1_800_000_000_000);
  assert.match(response.accessToken, /^lcbg_v1\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/);
  assert.equal(response.grant, summary);
  assert.equal(captured?.credentialLocator.byteLength, 16);
  assert.equal(captured?.credentialHash.byteLength, 32);
  assert.equal('accessToken' in (captured ?? {}), false);
});

test('grant mutation service preserves owner-scoped not-found and inactive classifications', async () => {
  const repository = {
    async revoke() {
      return { kind: 'not_found' as const };
    },
    async rotate() {
      return { kind: 'not_active' as const };
    },
  } as unknown as GrantRepository;
  const service = new GrantService(
    repository,
    new GrantCursorService(crypto),
    new GrantTokenService(crypto),
  );
  await assert.rejects(
    () => service.revoke(session, 'grant_1', 1_800_000_000_000),
    (error) => error instanceof AppError && error.code === 'GRANT_NOT_FOUND',
  );
  await assert.rejects(
    () => service.rotate(session, 'grant_1', 1_800_000_000_000),
    (error) => error instanceof AppError && error.code === 'GRANT_NOT_ACTIVE',
  );
});
