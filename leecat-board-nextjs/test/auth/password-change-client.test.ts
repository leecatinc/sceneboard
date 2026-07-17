import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AuthSessionClient } from '../../lib/auth/session-client';
import type {
  SessionRequestCoordinator,
  SharedCookieRequest,
} from '../../lib/auth/renewal-singleflight';

const clientWithResponse = (input: {
  snapshot: boolean;
  status: number;
  body: unknown;
  requests: SharedCookieRequest[];
}): AuthSessionClient => {
  const coordinator = {
    currentSnapshot() {
      return input.snapshot ? { csrfToken: 'session-csrf-token' } : null;
    },
    async dispatchShared(request: SharedCookieRequest) {
      input.requests.push(request);
      return {
        kind: 'ok' as const,
        value: {
          response: new Response(input.status === 204 ? null : JSON.stringify(input.body), {
            status: input.status,
            ...(input.status === 204 ? {} : { headers: { 'content-type': 'application/json' } }),
          }),
          body: input.body,
          bytes: new Uint8Array(),
        },
      };
    },
  } as unknown as SessionRequestCoordinator;
  return new AuthSessionClient(coordinator);
};

test('password change sends the current session CSRF token and exact password fields', async () => {
  const requests: SharedCookieRequest[] = [];
  const client = clientWithResponse({ snapshot: true, status: 204, body: null, requests });

  const result = await client.changePassword('current-password', 'replacement-password');

  assert.deepEqual(result, { kind: 'ok', value: null });
  assert.deepEqual(requests, [{
    path: '/api/v1/auth/password',
    method: 'POST',
    body: { currentPassword: 'current-password', newPassword: 'replacement-password' },
    csrfToken: 'session-csrf-token',
  }]);
});

test('password change preserves safe public error codes and refuses dispatch without a session', async () => {
  const requests: SharedCookieRequest[] = [];
  const client = clientWithResponse({
    snapshot: true,
    status: 400,
    body: { error: { code: 'AUTH_CURRENT_PASSWORD_INVALID', message: 'Current password is invalid' } },
    requests,
  });
  assert.deepEqual(await client.changePassword('wrong-password', 'replacement-password'), {
    kind: 'api_error',
    status: 400,
    code: 'AUTH_CURRENT_PASSWORD_INVALID',
  });

  const noSessionRequests: SharedCookieRequest[] = [];
  const noSession = clientWithResponse({ snapshot: false, status: 204, body: null, requests: noSessionRequests });
  assert.deepEqual(await noSession.changePassword('current-password', 'replacement-password'), {
    kind: 'reconciliation_required',
  });
  assert.deepEqual(noSessionRequests, []);
});
