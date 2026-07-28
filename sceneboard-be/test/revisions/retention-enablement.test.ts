import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';

import type { PoolConnection } from 'mysql2/promise';

import {
  RetentionEnablementService,
  type RetentionEnablementExpectationV1,
} from '../../src/revisions/retention/retention-enablement.service.js';

const key = Buffer.alloc(32, 7);
const expectation = (): RetentionEnablementExpectationV1 => ({
  deploymentId: 'deployment-2026-07-28',
  registryDigestHex: '11'.repeat(32),
  schemaProjectionSha256Hex: '22'.repeat(32),
  parityCertified: true,
  detachedReadFlip: true,
  detachedOnlyWriter: true,
  oldBinaryRejected: true,
  anchorZeroBytesCertified: true,
});

const certificateRow = () => ({
  deploymentId: expectation().deploymentId,
  attemptSeq: '9',
  registryDigestHex: expectation().registryDigestHex,
  schemaProjectionSha256Hex: expectation().schemaProjectionSha256Hex,
  sourceBackupSha256Hex: '33'.repeat(32),
  isolationId: 'restore-drill-9',
  quarantineSchema: 'sceneboard_quarantine_9',
  operatorPrincipal: 'retention-restore-drill',
  startedAt: '2026-07-28T00:00:00.000000Z',
  restoredAt: '2026-07-28T00:02:00.000000Z',
  certifiedAt: '2026-07-28T00:03:00.000000Z',
  expiresAt: '2026-08-27T00:03:00.000000Z',
  backupOk: 1,
  restoreOk: 1,
  projectionOk: 1,
  integrityOk: 1,
  evidenceSha256Hex: '44'.repeat(32),
  unexpired: 1,
});

const signatureFor = (row: ReturnType<typeof certificateRow>): Buffer =>
  createHmac('sha256', key)
    .update(
      Buffer.from(
        JSON.stringify({
          version: 1,
          deploymentId: row.deploymentId,
          attemptSeq: row.attemptSeq,
          registryDigest: row.registryDigestHex,
          schemaProjectionSha256: row.schemaProjectionSha256Hex,
          sourceBackupSha256: row.sourceBackupSha256Hex,
          isolationId: row.isolationId,
          quarantineSchema: row.quarantineSchema,
          operatorPrincipal: row.operatorPrincipal,
          startedAt: row.startedAt,
          restoredAt: row.restoredAt,
          certifiedAt: row.certifiedAt,
          expiresAt: row.expiresAt,
          backupOk: true,
          restoreOk: true,
          projectionOk: true,
          integrityOk: true,
          evidenceSha256: row.evidenceSha256Hex,
        }),
        'utf8',
      ),
    )
    .digest();

test('fails closed before database I/O when any retention prerequisite is absent', async () => {
  let calls = 0;
  const connection = {
    async execute() {
      calls += 1;
      return [[], []];
    },
  } as unknown as PoolConnection;
  const service = new RetentionEnablementService(key);
  assert.equal(
    await service.isEnabled(connection, { ...expectation(), parityCertified: false }),
    false,
  );
  assert.equal(calls, 0);
  assert.throws(() => new RetentionEnablementService(Buffer.alloc(31)), TypeError);
});

test('accepts only the latest unexpired same-deployment signed success', async () => {
  const row = certificateRow();
  const validConnection = {
    async execute(sql: string, binds: unknown[]) {
      assert.match(sql, /ORDER BY attempt_seq DESC\s+LIMIT 1/u);
      assert.deepEqual(binds, [expectation().deploymentId]);
      return [[{ ...row, signature: signatureFor(row) }], []];
    },
  } as unknown as PoolConnection;
  const service = new RetentionEnablementService(key);
  assert.equal(await service.isEnabled(validConnection, expectation()), true);

  for (const patch of [
    { unexpired: 0 },
    { integrityOk: 0 },
    { deploymentId: 'other-deployment' },
    { registryDigestHex: '55'.repeat(32) },
    { signature: Buffer.alloc(32) },
  ]) {
    const rejectedConnection = {
      async execute() {
        return [[{ ...row, signature: signatureFor(row), ...patch }], []];
      },
    } as unknown as PoolConnection;
    assert.equal(await service.isEnabled(rejectedConnection, expectation()), false);
  }
});
