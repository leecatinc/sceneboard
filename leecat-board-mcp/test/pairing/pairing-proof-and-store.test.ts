import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { InstallationIdentityStoreV1 } from '../../src/credentials/installation-identity.store.js';
import { PrivateFileCredentialStoreV1 } from '../../src/credentials/private-file-credential.store.js';

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
