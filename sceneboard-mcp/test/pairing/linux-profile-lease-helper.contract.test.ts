import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
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

test('helper acquisition abort terminates a pending helper handshake', async () => {
  if (process.platform !== 'linux') return;
  const root = await mkdtemp(join(tmpdir(), 'board-mcp-lease-abort-'));
  const state = join(root, 'state');
  await mkdir(state, { mode: 0o700 });
  const helperPath = join(root, 'pending-helper');
  const digestPath = join(root, 'pending-helper.sha256');
  const helperBytes = Buffer.from('#!/bin/sh\nread line\nread pending\n', 'utf8');
  await writeFile(helperPath, helperBytes, { mode: 0o500 });
  await writeFile(digestPath, `${createHash('sha256').update(helperBytes).digest('hex')}\n`, {
    mode: 0o600,
  });
  const adapter = new LinuxProfileLeaseHelperAdapterV1(helperPath, digestPath);
  const controller = new AbortController();
  const pending = adapter.acquire(state, controller.signal);
  setTimeout(() => controller.abort(), 20);
  const startedAt = performance.now();
  await assert.rejects(pending, (error: unknown) => (error as Error).name === 'AbortError');
  assert.equal(performance.now() - startedAt < 1_000, true);
});
