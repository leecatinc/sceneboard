import assert from 'node:assert/strict';
import test from 'node:test';

import { RetentionRecoveryService } from '../../src/revisions/retention/retention-recovery.service.js';
import type { RetentionLeaseV1 } from '../../src/revisions/retention/retention-lock.service.js';

const lease: RetentionLeaseV1 = {
  boardPk: '3',
  runId: 'run_1',
  ownerToken: 'owner_1',
  fence: '7',
};

const item = (phase: 'planned' | 'refs_detached' | 'payload_cleared') => ({
  phase,
  attempts: 2,
  anchorSha256: Buffer.alloc(32, 1),
  payloadSha256: Buffer.alloc(32, 2),
  holdSnapshotSha256: Buffer.alloc(32, 3),
});

const connectionV1 = (
  phase: 'planned' | 'refs_detached' | 'payload_cleared',
  activeHolds: readonly { kind: string; holder_id: string }[],
) => {
  const calls: string[] = [];
  const connection = {
    async execute(sql: string) {
      const normalized = sql.replace(/\s+/gu, ' ').trim();
      calls.push(normalized);
      if (normalized.includes('FROM board_retention_leases')) return [[{ board_pk: '3' }], []];
      if (normalized.includes('FROM board_retention_run_items')) return [[item(phase)], []];
      if (normalized.includes('FROM board_revisions')) return [[{ revision_pk: '9' }], []];
      if (normalized.includes('FROM board_revision_holds')) return [[...activeHolds], []];
      if (normalized.includes('FROM board_revision_media_refs')) return [[], []];
      if (normalized.includes('FROM board_revision_catalog c')) {
        return [[{ retainedOrder: '1', oldestRetainedOrder: '1' }], []];
      }
      if (normalized.startsWith('DELETE FROM board_revision_catalog')) {
        return [{ affectedRows: 1 }, []];
      }
      if (normalized.startsWith('DELETE')) return [{ affectedRows: 1 }, []];
      if (normalized.startsWith('UPDATE board_revision_catalog')) {
        return [{ affectedRows: 0 }, []];
      }
      if (normalized.startsWith('UPDATE board_retention_run_items')) {
        return [{ affectedRows: 1 }, []];
      }
      if (normalized.startsWith('UPDATE board_revision_recovery')) {
        return [{ affectedRows: 1 }, []];
      }
      throw new Error(`unexpected SQL: ${normalized}`);
    },
  };
  return { connection: connection as never, calls };
};

test('active holds defer every destructive retention phase without mutation or failure accounting', async () => {
  for (const phase of ['planned', 'refs_detached', 'payload_cleared'] as const) {
    const value = connectionV1(phase, [
      { kind: 'export', holder_id: `different_holder_${phase}` },
      { kind: 'publication', holder_id: 'share_1' },
    ]);
    assert.equal(await new RetentionRecoveryService().advance(value.connection, lease, '9'), phase);
    assert.equal(
      value.calls.some((call) => call.startsWith('DELETE')),
      false,
    );
    assert.equal(
      value.calls.some((call) => call.startsWith('UPDATE board_retention_run_items')),
      false,
    );
    assert.equal(
      value.calls.some((call) => call.includes('attempts =')),
      false,
    );
  }
});

test('released or expired holds permit all destructive phases in projection-compatible lock order', async () => {
  const expectations = [
    { phase: 'planned', next: 'refs_detached', destructive: 'board_revision_media_refs' },
    { phase: 'refs_detached', next: 'payload_cleared', destructive: 'board_revision_payloads' },
    { phase: 'payload_cleared', next: 'catalog_removed', destructive: 'board_revision_catalog c' },
  ] as const;
  for (const expectation of expectations) {
    const value = connectionV1(expectation.phase, []);
    assert.equal(
      await new RetentionRecoveryService().advance(value.connection, lease, '9'),
      expectation.next,
    );
    const revisionLock = value.calls.findIndex((call) => call.includes('FROM board_revisions'));
    const holdLock = value.calls.findIndex((call) => call.includes('FROM board_revision_holds'));
    const destructive = value.calls.findIndex((call) => call.includes(expectation.destructive));
    assert.ok(revisionLock >= 0 && revisionLock < holdLock && holdLock < destructive);
  }
});
