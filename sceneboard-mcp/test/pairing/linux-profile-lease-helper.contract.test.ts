import assert from 'node:assert/strict';
import { lstat, mkdtemp, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { LinuxProfileLeaseHelperAdapterV1 } from '../../src/credentials/linux-profile-lease-helper.adapter.js';
import { ProfileLeaseErrorV1 } from '../../src/credentials/profile-state.lease.js';

const helper = new URL('../../native/profile-lease-helper', import.meta.url).pathname;
const digest = new URL('../../native/profile-lease-helper.sha256', import.meta.url).pathname;

const privateDirectory = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'board-mcp-lease-'));
  const state = join(root, 'state');
  await mkdir(state, { mode: 0o700 });
  return state;
};

test('packaged Linux helper verifies mode, owner, and digest', async () => {
  const adapter = new LinuxProfileLeaseHelperAdapterV1(helper, digest);
  assert.equal(await adapter.verify(), true);
});

test('kernel lease has one owner, reports contention, and reacquires after release', async () => {
  const state = await privateDirectory();
  const first = new LinuxProfileLeaseHelperAdapterV1(helper, digest);
  const second = new LinuxProfileLeaseHelperAdapterV1(helper, digest);
  const lease = await first.acquire(state);
  await assert.rejects(
    () => second.acquire(state),
    (error: unknown) => error instanceof ProfileLeaseErrorV1 && error.reason === 'active_owner',
  );
  const record = JSON.parse(await readFile(join(state, 'profile.lease'), 'utf8')) as Record<
    string,
    unknown
  >;
  assert.deepEqual(Object.keys(record).sort(), ['nonce', 'pid', 'state', 'version']);
  assert.equal(record.state, 'live');
  const status = await lstat(join(state, 'profile.lease'));
  assert.equal(status.mode & 0o777, 0o600);
  await lease.release();
  const next = await second.acquire(state);
  await next.release();
});
