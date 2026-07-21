import assert from 'node:assert/strict';
import test from 'node:test';

import { PairingHttpClientV1 } from '../../src/pairing/pairing-http.client.js';

const headers = (vary: string | null = null): Record<string, string> => ({
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store, private',
  Pragma: 'no-cache',
  ...(vary === null ? {} : { Vary: vary }),
});

const claim = {
  code: 'ABCDEF-GHJKLM',
  installationId: 'install_abcdefghijklmnop',
  clientName: 'SceneBoard Codex',
  requestedScopes: ['board.read'] as const,
  requestedLifecyclePermissions: [] as const,
  clientProofChallenge: 'a'.repeat(43),
};

test('claim is unauthenticated and status/redeem use only the exact PairingProof header', async () => {
  const seen: Array<{ url: string; authorization: string | null; body: string | null }> = [];
  const responses = [
    new Response(
      JSON.stringify({
        pairingId: 'pairing_1',
        state: 'pending',
        decisionExpiresAt: '2026-07-16T17:00:00.000Z',
        pollAfterSeconds: 2,
      }),
      { status: 202, headers: headers() },
    ),
    new Response(
      JSON.stringify({
        pairingId: 'pairing_1',
        state: 'pending',
        retryAfterSeconds: 2,
        decisionExpiresAt: '2026-07-16T17:00:00.000Z',
        redeemExpiresAt: null,
      }),
      { status: 200, headers: headers('Authorization') },
    ),
    new Response(
      JSON.stringify({
        tokenType: 'Bearer',
        accessToken: `lcbg_v1.${'a'.repeat(22)}.${'b'.repeat(43)}`,
        grant: {
          grantId: 'grant_1',
          client: {
            clientId: 'client_1',
            clientName: 'SceneBoard Codex',
            installationFingerprint: 'abcdefghijklmnop',
          },
          scopes: ['board.write'],
          lifecyclePermissions: ['board.create'],
          boardIds: [],
          lifetime: 'persistent',
          status: 'active',
          createdAt: '2026-07-16T16:00:00.000Z',
          activatedAt: '2026-07-16T16:01:00.000Z',
          lastUsedAt: null,
          expiresAt: '2026-08-16T16:01:00.000Z',
          revokedAt: null,
        },
      }),
      { status: 200, headers: headers('Authorization') },
    ),
  ];
  const client = new PairingHttpClientV1({
    baseUrl: 'http://127.0.0.1:3001',
    timeoutMs: 30_000,
    proofHeaderProvider: () => 'p'.repeat(43),
    fetch: async (input, init) => {
      const request = new Request(input, init);
      seen.push({
        url: request.url,
        authorization: request.headers.get('authorization'),
        body: init?.body?.toString() ?? null,
      });
      return responses.shift()!;
    },
  });
  assert.equal(
    (
      await client.claim({
        ...claim,
        requestedScopes: [...claim.requestedScopes],
        requestedLifecyclePermissions: [],
      })
    ).ok,
    true,
  );
  assert.equal((await client.clientStatus('pairing_1')).ok, true);
  assert.equal((await client.redeem('pairing_1')).ok, true);
  assert.equal(seen[0]?.authorization, null);
  assert.equal(seen[1]?.authorization, `PairingProof ${'p'.repeat(43)}`);
  assert.equal(seen[2]?.authorization, `PairingProof ${'p'.repeat(43)}`);
  assert.equal(seen[2]?.body, '{}');
});

test('claim transport failure is one unknown outcome with no automatic retry', async () => {
  let attempts = 0;
  const client = new PairingHttpClientV1({
    baseUrl: 'http://127.0.0.1:3001',
    timeoutMs: 30_000,
    proofHeaderProvider: () => 'p'.repeat(43),
    fetch: async () => {
      attempts += 1;
      throw new TypeError('reset');
    },
  });
  const result = await client.claim({
    ...claim,
    requestedScopes: [...claim.requestedScopes],
    requestedLifecyclePermissions: [],
  });
  assert.deepEqual(result, {
    ok: false,
    source: 'local',
    error: { code: 'TRANSPORT_OUTCOME_UNKNOWN', phase: 'claim' },
  });
  assert.equal(attempts, 1);
});

test('pairing responses reject duplicate JSON, wrong Vary, and contradictory Retry-After', async () => {
  const cases = [
    new Response(
      '{"pairingId":"pairing_1","pairingId":"pairing_2","state":"pending","decisionExpiresAt":"2026-07-16T17:00:00.000Z","pollAfterSeconds":2}',
      { status: 202, headers: headers() },
    ),
    new Response(
      JSON.stringify({
        pairingId: 'pairing_1',
        state: 'pending',
        retryAfterSeconds: 2,
        decisionExpiresAt: '2026-07-16T17:00:00.000Z',
        redeemExpiresAt: null,
      }),
      { status: 200, headers: headers('Origin') },
    ),
    new Response(
      JSON.stringify({ error: { code: 'RATE_LIMITED', message: 'Too many requests' } }),
      { status: 429, headers: { ...headers(), 'Retry-After': '0' } },
    ),
  ];
  const client = new PairingHttpClientV1({
    baseUrl: 'http://127.0.0.1:3001',
    timeoutMs: 30_000,
    proofHeaderProvider: () => 'p'.repeat(43),
    fetch: async () => cases.shift()!,
  });
  assert.equal(
    (
      await client.claim({
        ...claim,
        requestedScopes: [...claim.requestedScopes],
        requestedLifecyclePermissions: [],
      })
    ).ok,
    false,
  );
  assert.equal((await client.clientStatus('pairing_1')).ok, false);
  assert.equal(
    (
      await client.claim({
        ...claim,
        requestedScopes: [...claim.requestedScopes],
        requestedLifecyclePermissions: [],
      })
    ).ok,
    false,
  );
});
