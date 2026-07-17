import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AuthSessionClient } from '../../lib/auth/session-client';
import type {
  SessionRequestCoordinator,
  SharedCookieRequest,
} from '../../lib/auth/renewal-singleflight';

const clientWithResponse = (input: {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
  requests: SharedCookieRequest[];
}): AuthSessionClient => {
  const coordinator = {
    async dispatchShared(request: SharedCookieRequest) {
      input.requests.push(request);
      return {
        kind: 'ok' as const,
        value: {
          response: new Response(JSON.stringify(input.body), {
            status: input.status,
            headers: { 'content-type': 'application/json', ...input.headers },
          }),
          body: input.body,
          bytes: new TextEncoder().encode(JSON.stringify(input.body)),
        },
      };
    },
  } as unknown as SessionRequestCoordinator;
  return new AuthSessionClient(coordinator);
};

test('email verification request sends only email and selected locale through the shared cookie lease', async () => {
  const requests: SharedCookieRequest[] = [];
  const client = clientWithResponse({
    status: 202,
    body: { expiresInSeconds: 600, resendAfterSeconds: 120 },
    requests,
  });

  const result = await client.requestEmailVerification('user@example.dev', 'ko');

  assert.deepEqual(result, { kind: 'ok', value: { expiresInSeconds: 600, resendAfterSeconds: 120 } });
  assert.deepEqual(requests, [{
    path: '/api/v1/auth/email-verifications',
    method: 'POST',
    body: { email: 'user@example.dev', locale: 'ko' },
  }]);
});

test('email verification confirmation admits only the exact ticket response', async () => {
  const requests: SharedCookieRequest[] = [];
  const client = clientWithResponse({
    status: 200,
    body: {
      verificationTicket: `v1.${'x'.repeat(100)}`,
      expiresAt: '2026-07-17T04:30:00.000Z',
    },
    requests,
  });

  const result = await client.confirmEmailVerification('user@example.dev', '123456');

  assert.equal(result.kind, 'ok');
  assert.deepEqual(requests[0]?.body, { email: 'user@example.dev', code: '123456' });
});

test('email verification preserves retry-after without exposing an untrusted error message', async () => {
  const requests: SharedCookieRequest[] = [];
  const client = clientWithResponse({
    status: 429,
    body: { error: { code: 'RATE_LIMITED', message: 'Too many requests' } },
    headers: { 'retry-after': '62' },
    requests,
  });

  const result = await client.requestEmailVerification('user@example.dev', 'en');

  assert.deepEqual(result, {
    kind: 'api_error',
    status: 429,
    code: 'RATE_LIMITED',
    retryAfterSeconds: 62,
  });
});
