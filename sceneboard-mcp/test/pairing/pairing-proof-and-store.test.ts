import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { InstallationIdentityStoreV1 } from '../../src/credentials/installation-identity.store.js';
import { PrivateFileCredentialStoreV1 } from '../../src/credentials/private-file-credential.store.js';
import { ProfileLeaseProviderV1 } from '../../src/credentials/profile-lease.provider.js';
import type {
  ProfileLeaseAdapterV1,
  ProfileStateLeaseV1,
} from '../../src/credentials/profile-state.lease.js';
import {
  StoredTokenProviderV1,
  type CredentialSnapshotV1,
} from '../../src/credentials/token-provider.js';

const token = (locator: string, verifier: string): string => `lcbg_v1.${locator}.${verifier}`;

test('private store atomically replaces generations and stale snapshots cannot delete replacements', async () => {
  const state = join(await mkdtemp(join(tmpdir(), 'board-mcp-store-')), 'profile');
  const store = new PrivateFileCredentialStoreV1(state);
  await store.preflight();
  const first = await store.replace(token('a'.repeat(22), 'b'.repeat(43)));
  const second = await store.replace(token('c'.repeat(22), 'd'.repeat(43)));
  assert.notEqual(first.generation, second.generation);
  assert.equal(await store.deleteIfCurrent(first), false);
  assert.deepEqual(await store.read(), second);
  assert.equal(await store.deleteIfCurrent(second), true);
  assert.equal(await store.read(), null);
});

test('installation identity is stable after the first atomic commit', async () => {
  const state = join(await mkdtemp(join(tmpdir(), 'board-mcp-installation-')), 'profile');
  const store = new PrivateFileCredentialStoreV1(state);
  await store.preflight();
  const identities = new InstallationIdentityStoreV1(state);
  const first = await identities.getOrCreate();
  const second = await identities.getOrCreate();
  assert.equal(first, second);
  assert.match(first, /^[A-Za-z0-9._:-]{16,128}$/);
});

test('stored pairing snapshots propagate cancellation and bound acquired-lease cleanup', async () => {
  const state = join(await mkdtemp(join(tmpdir(), 'board-mcp-store-cancel-')), 'profile');
  const store = new PrivateFileCredentialStoreV1(state);
  let readSignal: AbortSignal | undefined;
  let resolveRead: ((value: CredentialSnapshotV1 | null) => void) | undefined;
  store.read = (signal?: AbortSignal) =>
    new Promise((resolve) => {
      readSignal = signal;
      resolveRead = resolve;
    });
  let acquireSignal: AbortSignal | undefined;
  let releaseSignal: AbortSignal | undefined;
  let releaseCalls = 0;
  const lease: ProfileStateLeaseV1 = {
    release: async (signal?: AbortSignal) => {
      releaseCalls += 1;
      releaseSignal = signal;
    },
  };
  const adapter: ProfileLeaseAdapterV1 = {
    verify: async () => true,
    acquire: async (_stateDirectory, signal) => {
      acquireSignal = signal;
      return lease;
    },
  };
  const provider = new StoredTokenProviderV1(store, new ProfileLeaseProviderV1(adapter));
  const controller = new AbortController();
  const pending = provider.snapshot(controller.signal);
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  await assert.rejects(pending, (error: unknown) => (error as Error).name === 'AbortError');
  assert.equal(acquireSignal, controller.signal);
  assert.equal(readSignal, controller.signal);
  assert.equal(releaseSignal, controller.signal);
  assert.equal(releaseCalls, 1);
  resolveRead?.(null);
});
