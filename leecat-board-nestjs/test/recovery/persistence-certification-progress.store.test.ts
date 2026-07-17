import assert from 'node:assert/strict';
import { lstat, mkdir, readFile, rm, symlink } from 'node:fs/promises';
import { test } from 'node:test';

import {
  PersistenceCertificationProgressStore,
  type PersistenceCertificationProgressV1,
} from '../../src/bootstrap/persistence-certification-progress.store.js';
import { PERSISTENCE_PROBE_ORDER_V1 } from '../../src/bootstrap/persistence-certification.types.js';

const root = '/workspace/.tmp/agent/sceneboard-persistence-progress-tests';
const highWater = Object.fromEntries(PERSISTENCE_PROBE_ORDER_V1.map((probeId) => [probeId, '100'])) as Record<typeof PERSISTENCE_PROBE_ORDER_V1[number], string>;
const probes = Object.fromEntries(PERSISTENCE_PROBE_ORDER_V1.map((probeId) => [probeId, {
  lastVerifiedCursor: null,
  batchCount: 0,
  scannedRows: 0,
  scannedBytes: 0,
  complete: false,
}])) as PersistenceCertificationProgressV1['probes'];
const progress: PersistenceCertificationProgressV1 = {
  formatVersion: 1,
  mode: 'RESUMABLE_AUDIT',
  caller: 'db:persistence:scan',
  registryVersion: '012_d8_board_hitl_interactions',
  schemaFingerprintSha256: 'a'.repeat(64),
  databaseIdentitySha256: 'b'.repeat(64),
  capturedHighWaterMarks: highWater,
  probes,
  startedAt: '2026-07-17T00:00:00.000Z',
  updatedAt: '2026-07-17T00:00:01.000Z',
  completedAt: null,
  deferredRows: 0,
  failureCategory: null,
};
const identity = {
  mode: progress.mode,
  caller: progress.caller,
  registryVersion: progress.registryVersion,
  schemaFingerprintSha256: progress.schemaFingerprintSha256,
  databaseIdentitySha256: progress.databaseIdentitySha256,
  capturedHighWaterMarks: progress.capturedHighWaterMarks,
} as const;

test('writes canonical mode-0600 progress atomically and resumes only an exact identity', async () => {
  const caseRoot = `${root}/write-resume`;
  await rm(caseRoot, { recursive: true, force: true });
  await mkdir(caseRoot, { recursive: true });
  const path = `${caseRoot}/audit.json`;
  const store = new PersistenceCertificationProgressStore(path);
  await store.write(progress);
  assert.equal((await lstat(path)).mode & 0o777, 0o600);
  const source = await readFile(path, 'utf8');
  assert.equal(source.endsWith('\n'), true);
  assert.deepEqual(await store.readForResume(identity), progress);
  await assert.rejects(store.readForResume({ ...identity, registryVersion: 'different' }));
  await assert.rejects(store.readForResume({ ...identity, databaseIdentitySha256: 'c'.repeat(64) }));
  assert.deepEqual((await lstat(caseRoot)).isDirectory(), true);
});

test('rejects relative paths, symbolic-link targets, and non-canonical progress shapes', async () => {
  assert.throws(() => new PersistenceCertificationProgressStore('relative/progress.json'));
  const caseRoot = `${root}/invalid-paths`;
  await rm(caseRoot, { recursive: true, force: true });
  await mkdir(caseRoot, { recursive: true });
  const target = `${caseRoot}/target.json`;
  const link = `${caseRoot}/linked.json`;
  await new PersistenceCertificationProgressStore(target).write(progress);
  await symlink(target, link);
  const linkedStore = new PersistenceCertificationProgressStore(link);
  await assert.rejects(linkedStore.readForResume(identity));
  await assert.rejects(linkedStore.write(progress));
  await assert.rejects(new PersistenceCertificationProgressStore(`${caseRoot}/invalid.json`).write({
    ...progress,
    schemaFingerprintSha256: 'not-a-hash',
  } as never));
});
