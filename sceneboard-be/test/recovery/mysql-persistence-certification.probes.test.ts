import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createMysqlPersistenceCertificationProbes } from '../../src/bootstrap/mysql-persistence-certification.probes.js';
import { PERSISTENCE_PROBE_ORDER_V1 } from '../../src/bootstrap/persistence-certification.types.js';

test('executes every bounded MySQL canary in a short read-only transaction with low and high pages', async () => {
  const lifecycle: string[] = [];
  const sql: string[] = [];
  const connection = {
    query: async (statement: string) => {
      lifecycle.push(statement);
      return [[], []];
    },
    beginTransaction: async () => {
      lifecycle.push('BEGIN');
    },
    commit: async () => {
      lifecycle.push('COMMIT');
    },
    rollback: async () => {
      lifecycle.push('ROLLBACK');
    },
    execute: async (statement: string, binds: unknown[]) => {
      sql.push(statement);
      assert.deepEqual(binds, []);
      assert.match(statement, /LIMIT 100$/u);
      return [[], []];
    },
  };
  const mysql = {
    withConnection: async <Value>(operation: (value: typeof connection) => Promise<Value>) =>
      operation(connection),
  };
  const probes = createMysqlPersistenceCertificationProbes(mysql as never);
  assert.deepEqual(
    probes.map((probe) => probe.probeId),
    PERSISTENCE_PROBE_ORDER_V1,
  );
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
      complete: true,
      nextCursor: null,
      scannedRows: 0,
      scannedBytes: 0,
      deferredRows: 0,
    });
  }
  assert.equal(sql.length, 12);
  assert.equal(
    sql.every((statement) => statement.includes('MAX_EXECUTION_TIME(5000)')),
    true,
  );
  assert.equal(lifecycle.filter((entry) => entry === 'SET TRANSACTION READ ONLY').length, 6);
  assert.equal(lifecycle.filter((entry) => entry === 'BEGIN').length, 6);
  assert.equal(lifecycle.filter((entry) => entry === 'COMMIT').length, 6);
  assert.equal(lifecycle.includes('ROLLBACK'), false);
});

test('refuses an aborted canary before opening a database transaction', async () => {
  const controller = new AbortController();
  controller.abort();
  const probes = createMysqlPersistenceCertificationProbes({
    withConnection: async () => {
      throw new Error('must not connect');
    },
  } as never);
  await assert.rejects(
    probes[0]!.run({
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
    }),
    { name: 'PersistenceProbeFailure' },
  );
});

test('accepts fully reclaimed revisions in lineage and checkpoint canaries', async () => {
  const revisionId = Buffer.from('00112233445546778899aabbccddeeff', 'hex');
  const connection = {
    query: async () => [[], []],
    beginTransaction: async () => undefined,
    commit: async () => undefined,
    rollback: async () => undefined,
    execute: async (statement: string) => {
      if (statement.includes('actualStoredBytes')) {
        return [
          [
            {
              cursorPk: '1',
              revisionId,
              boardPk: '1',
              revisionNumber: '1',
              previousBoardPk: null,
              sourceBoardPk: null,
              sceneStoredBytes: null,
              actualStoredBytes: null,
            },
          ],
          [],
        ];
      }
      return [
        [
          {
            cursorPk: '1',
            scenePayload: null,
            sceneStoredBytes: null,
            sceneSha256: null,
            referenceCount: 0,
            invalidReferenceCount: 0,
          },
        ],
        [],
      ];
    },
  };
  const probes = createMysqlPersistenceCertificationProbes({
    withConnection: async <Value>(operation: (value: typeof connection) => Promise<Value>) =>
      operation(connection),
  } as never);

  for (const probe of [probes[2]!, probes[5]!]) {
    const result = await probe.run({
      probeId: probe.probeId,
      mode: 'BOUNDED_RESTART',
      scope: 'bounded-canary',
      cursor: null,
      maxRows: 200,
      maxMetadataBytes: 1_048_576,
      maxPayloadBytes: 33_554_432,
      statementTimeoutMs: 5_000,
      batchDeadlineMs: 15_000,
      signal: new AbortController().signal,
    });
    assert.equal(result.scannedRows, 1);
  }
});
