import assert from 'node:assert/strict';
import test from 'node:test';

import { AccountApiKeyApi } from '../../lib/api/account-api-key-api';
import type {
  ConsumedResponse,
  SessionRequestCoordinator,
  SharedCookieRequest,
} from '../../lib/auth/renewal-singleflight';

const csrfToken = 'lcbcsrf_v1.s.binding.nonce.1800000000000.mac';
const rawKey = 'sbk_v1.AAAAAAAAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const metadata = {
  apiKeyId: 'key_public_1',
  name: 'Automation',
  prefix: 'sbk_v1.AAAAAAAA…',
  scopes: ['board:read'],
  status: 'active',
  createdAt: '2026-07-30T00:00:00.000Z',
  expiresAt: '2026-10-28T00:00:00.000Z',
  lastUsedAt: null,
};

const consumed = (status: number, body: unknown): ConsumedResponse => ({
  response: new Response(status === 204 ? null : JSON.stringify(body), { status }),
  body,
  bytes: status === 204 ? new Uint8Array() : new TextEncoder().encode(JSON.stringify(body)),
});

const setup = (responses: ConsumedResponse[]) => {
  const requests: SharedCookieRequest[] = [];
  const coordinator = {
    currentSnapshot: () => ({ csrfToken }),
    dispatchShared: async (request: SharedCookieRequest) => {
      requests.push(request);
      const response = responses.shift();
      if (response === undefined) throw new TypeError('missing fixture response');
      return { kind: 'ok' as const, value: response };
    },
  } as unknown as SessionRequestCoordinator;
  return { api: new AccountApiKeyApi(coordinator), requests };
};

test('account API-key adapter sends closed session requests and never persists the raw key', async () => {
  const value = setup([
    consumed(200, { items: [metadata], nextCursor: null }),
    consumed(201, { apiKey: rawKey, metadata }),
    consumed(204, null),
  ]);
  const signal = new AbortController().signal;
  const listed = await value.api.list(signal);
  const created = await value.api.create(
    {
      displayName: 'Automation',
      scopes: ['board:read'],
      expiresAt: metadata.expiresAt,
    },
    signal,
  );
  const revoked = await value.api.revoke(metadata.apiKeyId, signal);
  assert.equal(listed.kind, 'ok');
  assert.deepEqual(created, { kind: 'ok', value: { apiKey: rawKey, metadata } });
  assert.deepEqual(revoked, { kind: 'ok', value: null });
  assert.deepEqual(
    value.requests.map(({ path, method, csrfToken: csrf, body }) => ({
      path,
      method,
      csrf,
      body,
    })),
    [
      {
        path: '/api/v1/account/api-keys?limit=20',
        method: 'GET',
        csrf: csrfToken,
        body: undefined,
      },
      {
        path: '/api/v1/account/api-keys',
        method: 'POST',
        csrf: csrfToken,
        body: {
          displayName: 'Automation',
          scopes: ['board:read'],
          expiresAt: metadata.expiresAt,
        },
      },
      {
        path: '/api/v1/account/api-keys/key_public_1',
        method: 'DELETE',
        csrf: csrfToken,
        body: undefined,
      },
    ],
  );
  assert.equal(
    value.requests.every((request) => request.signal === signal),
    true,
  );
  assert.equal(JSON.stringify(value.requests).includes(rawKey), false);
});

test('account API-key adapter rejects response shape drift and requires an active session', async () => {
  const corrupt = setup([
    consumed(200, { items: [{ ...metadata, rawKey }], nextCursor: null }),
    consumed(201, { apiKey: `${rawKey}x`, metadata }),
  ]);
  assert.deepEqual(await corrupt.api.list(), { kind: 'corrupt_response' });
  assert.deepEqual(
    await corrupt.api.create({
      displayName: 'Automation',
      scopes: ['board:read'],
      expiresAt: metadata.expiresAt,
    }),
    { kind: 'corrupt_response' },
  );
  const sessionless = new AccountApiKeyApi({
    currentSnapshot: () => null,
  } as unknown as SessionRequestCoordinator);
  assert.deepEqual(await sessionless.list(), { kind: 'reconciliation_required' });
});
