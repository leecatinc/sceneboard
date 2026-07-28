import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  authorizeHttpMcpBootstrap,
  buildCertificationDispatch,
  certifyPersistenceForCaller,
} from '../../src/bootstrap/persistence-certification.bootstrap.js';
import { PersistenceCertificationService } from '../../src/bootstrap/persistence-certification.service.js';
import {
  PERSISTENCE_PROBE_ORDER_V1,
  PersistenceProbeFailure,
  type PersistenceCertificationProbeV1,
} from '../../src/bootstrap/persistence-certification.types.js';

const state = {
  mode: 'restart',
  registryVersion: '013_d9_v2_checkpoint_capacity',
  connectionProfile: {
    databaseIdentitySha256: 'a'.repeat(64),
    serverVersion: '8.0.40',
    timeZone: '+00:00',
    characterSet: 'utf8mb4',
    collation: 'utf8mb4_0900_ai_ci',
    sqlModeSha256: 'b'.repeat(64),
  },
} as const;

const probes = (observed: string[], failAt?: string): PersistenceCertificationProbeV1[] =>
  PERSISTENCE_PROBE_ORDER_V1.map((probeId) => ({
    probeId,
    run: async (input) => {
      observed.push(input.probeId);
      assert.equal(input.statementTimeoutMs, 5_000);
      assert.equal(input.batchDeadlineMs, 15_000);
      assert.ok(input.maxRows <= 200);
      if (probeId === failAt) throw new PersistenceProbeFailure('ROW_MAPPING', false);
      return {
        complete: true,
        nextCursor: null,
        scannedRows: 1,
        scannedBytes: 100,
        deferredRows: 0,
      };
    },
  }));

test('runs the exact bounded probe graph and grants listener authority only to bootstrap', async () => {
  const observed: string[] = [];
  const service = new PersistenceCertificationService(
    probes(observed),
    () => new Date('2026-07-17T00:00:00.000Z'),
  );
  assert.equal(await authorizeHttpMcpBootstrap(service, state), true);
  assert.deepEqual(observed, PERSISTENCE_PROBE_ORDER_V1);

  const status = await certifyPersistenceForCaller(service, 'db:migrate:status', state);
  assert.equal(status.status, 'succeeded');
  assert.equal(status.authorizesListener, false);
  assert.equal(
    status.status === 'succeeded' && status.successAction,
    'CLI_EXIT_0_BOUNDED_REPORT_ONLY',
  );
});

test('returns only a safe failure value and never grants listener authority after a probe failure', async () => {
  const service = new PersistenceCertificationService(probes([], 'revision-head-lineage'));
  const result = await certifyPersistenceForCaller(service, 'http-mcp.bootstrap', state);
  assert.deepEqual(result, {
    status: 'failed',
    code: 'PERSISTENCE_CERTIFICATION_FAILED',
    category: 'ROW_MAPPING',
    caller: 'http-mcp.bootstrap',
    certificationMode: 'BOUNDED_RESTART',
    stateMode: 'restart',
    registryVersion: '013_d9_v2_checkpoint_capacity',
    retryable: false,
    authorizesListener: false,
  });
  assert.equal('message' in result, false);
  assert.equal('cursor' in result, false);
});

test('denies exposure when an injected service returns an uncorrelated result', async () => {
  const result = await certifyPersistenceForCaller(
    {
      certify: async () => ({
        status: 'succeeded',
        caller: 'db:migrate:status',
        certificationMode: 'BOUNDED_RESTART',
        stateMode: 'restart',
        registryVersion: state.registryVersion,
        connectionProfile: state.connectionProfile,
        certifiedAt: '2026-07-17T00:00:00.000Z',
        scannedRows: 0,
        scannedBytes: 0,
        deferredRows: 0,
        successAction: 'CLI_EXIT_0_BOUNDED_REPORT_ONLY',
        authorizesListener: false,
      }),
    } as never,
    'http-mcp.bootstrap',
    state,
  );
  assert.equal(result.status, 'failed');
  assert.equal(result.authorizesListener, false);
  assert.equal(result.status === 'failed' && result.category, 'STATE_OR_PROFILE');
});

test('rejects a probe graph with a missing or duplicate owner', () => {
  assert.throws(() => new PersistenceCertificationService(probes([]).slice(1)));
  const duplicate = probes([]);
  duplicate[1] = duplicate[0]!;
  assert.throws(() => new PersistenceCertificationService(duplicate));
});

test('full scans advance only through valid unique cursors and exceed one batch without a global restart deadline', async () => {
  const calls = new Map<string, number>();
  const completeProbes = PERSISTENCE_PROBE_ORDER_V1.map(
    (probeId): PersistenceCertificationProbeV1 => ({
      probeId,
      run: async ({ cursor, maxRows, scope }) => {
        assert.equal(scope, 'complete-keyset');
        assert.ok(maxRows >= 100);
        const count = (calls.get(probeId) ?? 0) + 1;
        calls.set(probeId, count);
        return count === 1
          ? {
              complete: false,
              nextCursor: cursor === null ? 'verified-page-1' : `${cursor}-next`,
              scannedRows: 1,
              scannedBytes: 1,
              deferredRows: 0,
            }
          : { complete: true, nextCursor: null, scannedRows: 1, scannedBytes: 1, deferredRows: 0 };
      },
    }),
  );
  const service = new PersistenceCertificationService(completeProbes);
  const result = await service.certify(
    buildCertificationDispatch('db:migrate:up', { ...state, mode: 'restart' }),
  );
  assert.equal(result.status, 'succeeded');
  assert.deepEqual([...calls.values()], [2, 2, 2, 2, 2, 2]);
});
