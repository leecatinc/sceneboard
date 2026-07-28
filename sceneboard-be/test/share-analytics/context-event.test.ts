import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ShareAnalyticsError } from '../../src/common/errors/share-analytics.error.js';
import { CryptoService } from '../../src/common/security/crypto.service.js';
import {
  shareAnalyticsCsrfCookieName,
  shareAnalyticsViewerCookieName,
  ViewerIdentityService,
} from '../../src/share-analytics/context/viewer-identity.service.js';

const crypto = () => {
  let byte = 1;
  return new CryptoService(
    {
      sessionToken: Buffer.alloc(32, 1),
      grantToken: Buffer.alloc(32, 2),
      csrf: Buffer.alloc(32, 3),
      pairingCodePepper: Buffer.alloc(32, 4),
      auditHmac: Buffer.alloc(32, 5),
      rateLimitHmac: Buffer.alloc(32, 6),
    },
    (length) => {
      const output = Buffer.alloc(length, byte);
      byte += 1;
      return output;
    },
  );
};

test('issues exact isolated viewer and analytics CSRF cookies without durable seed state', () => {
  const identities = new ViewerIdentityService(crypto());
  const viewer = identities.ensure(undefined);
  assert.ok(viewer.setCookie?.startsWith(`${shareAnalyticsViewerCookieName}=`));
  assert.match(
    viewer.setCookie ?? '',
    /Max-Age=15552000; Path=\/; Secure; HttpOnly; SameSite=Lax$/u,
  );
  const now = new Date('2026-07-28T00:00:00.000Z');
  const expiresAt = new Date('2026-07-28T00:30:00.000Z');
  const csrf = identities.issueCsrf({
    seed: viewer.seed,
    contextId: 'context-a',
    now,
    expiresAt,
  });
  assert.ok(csrf.setCookie.startsWith(`${shareAnalyticsCsrfCookieName}=`));
  assert.match(csrf.setCookie, /Max-Age=1800; Path=\/api\/v1\/public\/; Secure; SameSite=Lax$/u);
  const viewerToken = viewer.setCookie!.split(';', 1)[0]!;
  const cookieHeader = `${viewerToken}; ${shareAnalyticsCsrfCookieName}=${csrf.token}`;
  assert.doesNotThrow(() =>
    identities.assertCsrf({
      cookieHeader,
      header: csrf.token,
      seed: viewer.seed,
      contextId: 'context-a',
      now,
    }),
  );
  assert.throws(
    () =>
      identities.assertCsrf({
        cookieHeader,
        header: csrf.token,
        seed: viewer.seed,
        contextId: 'context-b',
        now,
      }),
    (error) => error instanceof ShareAnalyticsError && error.code === 'CSRF_INVALID',
  );
});

test('derives three full-width purpose-separated keys with context and day boundaries', () => {
  const identities = new ViewerIdentityService(crypto());
  const seed = Buffer.alloc(32, 9);
  const first = identities.derivatives({
    seed,
    contextId: 'context-a',
    utcDate: '2026-07-28',
  });
  const repeated = identities.derivatives({
    seed,
    contextId: 'context-a',
    utcDate: '2026-07-28',
  });
  const nextDay = identities.derivatives({
    seed,
    contextId: 'context-a',
    utcDate: '2026-07-29',
  });
  for (const value of Object.values(first)) assert.equal(value.byteLength, 32);
  assert.deepEqual(first, repeated);
  assert.notDeepEqual(first.replayFamilyKey, first.viewerDedupeKey);
  assert.notDeepEqual(first.viewerDailyKey, nextDay.viewerDailyKey);
  assert.deepEqual(first.replayFamilyKey, nextDay.replayFamilyKey);
  assert.deepEqual(first.viewerDedupeKey, nextDay.viewerDedupeKey);
});
