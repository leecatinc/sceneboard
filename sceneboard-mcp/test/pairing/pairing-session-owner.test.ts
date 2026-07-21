import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { InstallationIdentityStoreV1 } from '../../src/credentials/installation-identity.store.js';
import { LinuxProfileLeaseHelperAdapterV1 } from '../../src/credentials/linux-profile-lease-helper.adapter.js';
import { PrivateFileCredentialStoreV1 } from '../../src/credentials/private-file-credential.store.js';
import { ProfileLeaseProviderV1 } from '../../src/credentials/profile-lease.provider.js';
import { PairingHttpClientV1 } from '../../src/pairing/pairing-http.client.js';
import { PairingSessionOwnerV1 } from '../../src/pairing/pairing-session.owner.js';

const helper = new URL('../../native/profile-lease-helper', import.meta.url).pathname;
const digest = new URL('../../native/profile-lease-helper.sha256', import.meta.url).pathname;
const responseHeaders = (vary: string | null = null): Record<string, string> => ({
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store, private',
  Pragma: 'no-cache',
  ...(vary === null ? {} : { Vary: vary }),
});

test('approval redeems once, atomically commits the token, probes it, and returns only a safe grant', async () => {
  const state = join(await mkdtemp(join(tmpdir(), 'board-mcp-session-')), 'profile');
  const store = new PrivateFileCredentialStoreV1(state);
  const leaseProvider = new ProfileLeaseProviderV1(
    new LinuxProfileLeaseHelperAdapterV1(helper, digest),
  );
  const requests: Request[] = [];
  const queue = [
    new Response(
      JSON.stringify({
        pairingId: 'pairing_1',
        state: 'pending',
        decisionExpiresAt: '2026-07-16T17:00:00.000Z',
        pollAfterSeconds: 2,
      }),
      { status: 202, headers: responseHeaders() },
    ),
    new Response(
      JSON.stringify({
        pairingId: 'pairing_1',
        state: 'approved',
        retryAfterSeconds: null,
        decisionExpiresAt: '2026-07-16T17:00:00.000Z',
        redeemExpiresAt: '2026-07-16T17:15:00.000Z',
      }),
      { status: 200, headers: responseHeaders('Authorization') },
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
          scopes: ['board.read', 'board.write'],
          lifecyclePermissions: ['board.create'],
          boardIds: ['board_1'],
          lifetime: 'persistent',
          status: 'active',
          createdAt: '2026-07-16T16:00:00.000Z',
          activatedAt: '2026-07-16T16:01:00.000Z',
          lastUsedAt: null,
          expiresAt: '2026-08-16T16:01:00.000Z',
          revokedAt: null,
        },
      }),
      { status: 200, headers: responseHeaders('Authorization') },
    ),
  ];
  let probedToken = '';
  const owner = new PairingSessionOwnerV1(
    store,
    new InstallationIdentityStoreV1(state),
    leaseProvider,
    (proof) =>
      new PairingHttpClientV1({
        baseUrl: 'http://127.0.0.1:3001',
        timeoutMs: 30_000,
        proofHeaderProvider: proof,
        fetch: async (input, init) => {
          requests.push(new Request(input, init));
          return queue.shift()!;
        },
      }),
    async (accessToken) => {
      probedToken = accessToken;
      return true;
    },
  );
  const requested = await owner.request({
    code: 'ABCDEF-GHJKLM',
    clientName: 'SceneBoard Codex',
    requestedScopes: ['board.read', 'board.write'],
    requestedLifecyclePermissions: ['board.create'],
  });
  assert.deepEqual(requested.ok && requested.value, {
    pairingId: 'pairing_1',
    state: 'pending',
    decisionExpiresAt: '2026-07-16T17:00:00.000Z',
    pollAfterSeconds: 2,
    hasToken: false,
  });
  const claimedBody = JSON.parse(await requests[0]!.text()) as Record<string, unknown>;
  assert.equal(typeof claimedBody.clientProofChallenge, 'string');
  assert.equal(String(claimedBody.clientProofChallenge).length, 43);
  assert.equal('accessToken' in claimedBody, false);

  const status = await owner.status('pairing_1', 0);
  assert.equal(status.ok, true);
  if (!status.ok) return;
  assert.equal(status.value.state, 'redeemed');
  assert.equal(JSON.stringify(status.value).includes('accessToken'), false);
  assert.equal(probedToken, `lcbg_v1.${'a'.repeat(22)}.${'b'.repeat(43)}`);
  assert.equal((await store.read())?.accessToken, probedToken);
  assert.equal(requests[1]?.headers.get('authorization')?.startsWith('PairingProof '), true);
  assert.equal(requests[2]?.headers.get('authorization')?.startsWith('PairingProof '), true);
});
