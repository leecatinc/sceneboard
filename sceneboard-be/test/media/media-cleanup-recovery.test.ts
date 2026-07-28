import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

import {
  canonicalMediaBackupCertificate,
  MediaRecoveryService,
  mediaBackupObjectMatches,
} from '../../src/media/media-recovery.service.js';

test('the tenth cleanup failure quarantines the item under the exact live lease fence', async () => {
  const updates: unknown[][] = [];
  const connection = {
    execute: async (sql: string, values: unknown[] = []) => {
      const normalized = sql.replace(/\s+/gu, ' ').trim();
      if (normalized.includes('FROM media_cleanup_runs')) return [[{}]];
      if (normalized.includes('FROM media_cleanup_items WHERE cleanup_id')) {
        return [
          [
            {
              cleanupId: '1',
              boardPk: '2',
              boardMediaPk: '3',
              mediaPk: '4',
              expectedBoardMediaVersion: '5',
              expectedObjectVersion: '6',
              phase: 'object_quarantined',
              attempts: 9,
              objectSha256: Buffer.alloc(32, 1),
              byteLength: 10,
              deleteAfter: '2026-08-04 00:00:00.000',
              backupDeploymentId: null,
              backupAttemptSeq: null,
              backupManifestSha256: null,
            },
          ],
        ];
      }
      if (normalized.startsWith('UPDATE media_cleanup_items item')) {
        updates.push(values);
        return [{ affectedRows: 1 }];
      }
      throw new Error(`unexpected SQL: ${normalized}`);
    },
  };
  const phase = await new MediaRecoveryService(
    {} as never,
    {
      hmac: () => Buffer.alloc(32),
    } as never,
  ).recordFailure(
    connection as never,
    { runId: 'run_1', leaseOwner: 'worker_1', fence: 8n },
    1n,
    'BACKUP_INVALID',
  );
  assert.equal(phase, 'quarantined');
  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0]?.slice(0, 3), [10, 'quarantined', 'BACKUP_INVALID']);
  assert.deepEqual(updates[0]?.slice(-3), ['run_1', 'worker_1', '8']);
});

test('backup authority binds both exact bytes digest and length', () => {
  const digest = Buffer.alloc(32, 7);
  assert.equal(
    mediaBackupObjectMatches(
      { sha256: digest, byteLength: 10 },
      { sha256: Buffer.from(digest), byteLength: 10 },
    ),
    true,
  );
  assert.equal(
    mediaBackupObjectMatches(
      { sha256: digest, byteLength: 10 },
      { sha256: Buffer.alloc(32, 8), byteLength: 10 },
    ),
    false,
  );
  assert.equal(
    mediaBackupObjectMatches(
      { sha256: digest, byteLength: 10 },
      { sha256: Buffer.from(digest), byteLength: 9 },
    ),
    false,
  );
});

test('media backup certificate canonicalization binds exact authority fields and boolean outcomes', () => {
  const canonical = canonicalMediaBackupCertificate({
    deploymentId: 'deploy_1',
    attemptSeq: '7',
    sourceBackupSha256Hex: '11'.repeat(32),
    mediaManifestSha256Hex: '22'.repeat(32),
    certifiedAt: '2026-07-28T00:00:00.000000Z',
    expiresAt: '2026-08-27T00:00:00.000000Z',
    backupOk: 1,
    restoreOk: 1,
    integrityOk: 0,
  });
  assert.deepEqual(JSON.parse(canonical.toString('utf8')), {
    version: 1,
    deploymentId: 'deploy_1',
    attemptSeq: '7',
    sourceBackupSha256: '11'.repeat(32),
    mediaManifestSha256: '22'.repeat(32),
    certifiedAt: '2026-07-28T00:00:00.000000Z',
    expiresAt: '2026-08-27T00:00:00.000000Z',
    backupOk: true,
    restoreOk: true,
    integrityOk: false,
  });
});

test('zero-ownership cleanup locks and verifies object bytes before ownership, holds, and refs', async () => {
  const order: string[] = [];
  const digest = Buffer.alloc(32, 3);
  const bytes = Buffer.from('cleanup-object');
  const actualDigest = createHash('sha256').update(bytes).digest();
  const connection = {
    execute: async (sql: string) => {
      const normalized = sql.replace(/\s+/gu, ' ').trim();
      if (normalized.includes('FROM media_cleanup_runs')) return [[{}]];
      if (normalized.includes('FROM media_cleanup_items WHERE cleanup_id'))
        return [
          [
            {
              cleanupId: '1',
              boardPk: '2',
              boardMediaPk: '3',
              mediaPk: '4',
              expectedBoardMediaVersion: '6',
              expectedObjectVersion: '7',
              phase: 'ownership_released',
              attempts: 0,
              objectSha256: actualDigest,
              byteLength: bytes.byteLength,
              deleteAfter: null,
              backupDeploymentId: null,
              backupAttemptSeq: null,
              backupManifestSha256: null,
            },
          ],
        ];
      if (normalized === 'SELECT UTC_TIMESTAMP(3) AS nowSql')
        return [[{ nowSql: '2026-07-28 00:00:00.000' }]];
      if (normalized.startsWith('UPDATE media_objects')) return [{ affectedRows: 1 }];
      if (normalized.startsWith('UPDATE media_cleanup_items item')) return [{ affectedRows: 1 }];
      throw new Error(`unexpected SQL: ${normalized}`);
    },
  };
  const media = {
    getCanonicalObject: async () => {
      order.push('object');
      return {
        mediaPk: 4n,
        sha256: actualDigest,
        bytes,
        mime: 'image/png',
        width: 1,
        height: 1,
        byteLength: bytes.byteLength,
        state: 'active',
        version: 7n,
      };
    },
    countLiveOwnerships: async () => {
      order.push('ownership');
      return 0;
    },
    lockStrongMediaHolds: async () => {
      order.push('holds');
      return [];
    },
    hasAnyExactMediaRef: async () => {
      order.push('refs');
      return false;
    },
  };
  const phase = await new MediaRecoveryService(
    media as never,
    { hmac: () => digest } as never,
  ).advance(connection as never, { runId: 'run_1', leaseOwner: 'worker_1', fence: 8n }, 1n);
  assert.equal(phase, 'object_quarantined');
  assert.deepEqual(order, ['object', 'ownership', 'holds', 'refs']);
});
