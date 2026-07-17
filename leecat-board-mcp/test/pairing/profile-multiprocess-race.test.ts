import assert from 'node:assert/strict';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { LinuxProfileLeaseHelperAdapterV1 } from '../../src/credentials/linux-profile-lease-helper.adapter.js';
import { ProfileLeaseErrorV1 } from '../../src/credentials/profile-state.lease.js';

const helper = new URL('../../native/profile-lease-helper', import.meta.url).pathname;
const digest = new URL('../../native/profile-lease-helper.sha256', import.meta.url).pathname;

test('concurrent helper processes produce exactly one proven kernel owner', async () => {
  const state = join(await mkdtemp(join(tmpdir(), 'board-mcp-race-')), 'state');
  await mkdir(state, { mode: 0o700 });
  const adapters = Array.from({ length: 4 }, () => new LinuxProfileLeaseHelperAdapterV1(helper, digest));
  const results = await Promise.allSettled(adapters.map((adapter) => adapter.acquire(state)));
  const owners = results.filter((result): result is PromiseFulfilledResult<Awaited<ReturnType<LinuxProfileLeaseHelperAdapterV1['acquire']>>> => result.status === 'fulfilled');
  const contenders = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
  try {
    assert.equal(owners.length, 1);
    assert.equal(contenders.length, 3);
    for (const contender of contenders) {
      assert.ok(contender.reason instanceof ProfileLeaseErrorV1);
      assert.equal(contender.reason.reason, 'active_owner');
    }
  } finally {
    await Promise.all(owners.map((owner) => owner.value.release()));
  }
});
