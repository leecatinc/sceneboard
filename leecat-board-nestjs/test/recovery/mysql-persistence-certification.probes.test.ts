import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createMysqlPersistenceCertificationProbes } from '../../src/bootstrap/mysql-persistence-certification.probes.js';
import { PERSISTENCE_PROBE_ORDER_V1 } from '../../src/bootstrap/persistence-certification.types.js';

test('executes every bounded MySQL canary in a short read-only transaction with low and high pages', async () => {
  const lifecycle: string[] = [];
  const sql: string[] = [];
  const connection = {
    query: async (statement: string) => { lifecycle.push(statement); return [[], []]; },
    beginTransaction: async () => { lifecycle.push('BEGIN'); },
    commit: async () => { lifecycle.push('COMMIT'); },
    rollback: async () => { lifecycle.push('ROLLBACK'); },
    execute: async (statement: string, binds: unknown[]) => {
      sql.push(statement);
      assert.deepEqual(binds, [100]);
      return [[], []];
    },
  };
  const mysql = {
    withConnection: async <Value>(operation: (value: typeof connection) => Promise<Value>) => operation(connection),
  };
  const probes = createMysqlPersistenceCertificationProbes(mysql as never);
  assert.deepEqual(probes.map((probe) => probe.probeId), PERSISTENCE_PROBE_ORDER_V1);
  for (const probe of probes) {
    const result = await probe.run({
      probeId: probe.probeId,
      mode: 'BOUNDED_RESTART',
      scope: 'bounded-canary',
      cursor: null,
      maxRows: 200,
      maxMetadataBytes: 1_048_576,
      maxPayloadBytes: 16_777_216,
      statementTimeoutMs: 5_000,
      batchDeadlineMs: 15_000,
      signal: new AbortController().signal,
    });
    assert.deepEqual(result, {
      complete: true, nextCursor: null, scannedRows: 0, scannedBytes: 0, deferredRows: 0,
    });
  }
  assert.equal(sql.length, 12);
  assert.equal(sql.every((statement) => statement.includes('MAX_EXECUTION_TIME(5000)')), true);
  assert.equal(lifecycle.filter((entry) => entry === 'SET TRANSACTION READ ONLY').length, 6);
  assert.equal(lifecycle.filter((entry) => entry === 'BEGIN').length, 6);
  assert.equal(lifecycle.filter((entry) => entry === 'COMMIT').length, 6);
  assert.equal(lifecycle.includes('ROLLBACK'), false);
});

test('refuses an aborted canary before opening a database transaction', async () => {
  const controller = new AbortController();
  controller.abort();
  const probes = createMysqlPersistenceCertificationProbes({
    withConnection: async () => { throw new Error('must not connect'); },
  } as never);
  await assert.rejects(probes[0]!.run({
    probeId: probes[0]!.probeId,
    mode: 'BOUNDED_RESTART',
    scope: 'bounded-canary',
    cursor: null,
    maxRows: 200,
    maxMetadataBytes: 1_048_576,
    maxPayloadBytes: 16_777_216,
    statementTimeoutMs: 5_000,
    batchDeadlineMs: 15_000,
    signal: controller.signal,
  }), { name: 'PersistenceProbeFailure' });
});
