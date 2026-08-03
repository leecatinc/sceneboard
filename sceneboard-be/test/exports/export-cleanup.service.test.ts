import assert from 'node:assert/strict';
import test from 'node:test';

import { BoardPersistenceError } from '../../src/common/errors/board-persistence.error.js';
import { ExportCleanupServiceV1 } from '../../src/exports/export-cleanup.service.js';
import { ExportTerminalAuditRepositoryV1 } from '../../src/exports/export-terminal-audit.repository.js';

type IntentRowV1 = {
  correlationId: string;
  actorKind: 'user' | 'service';
  actorPublicId: string;
  format: 'pdf' | 'pptx';
  revisionNumber: string;
  outcome: 'pending' | 'completed' | 'failed';
  completedBytes: string | null;
  failureReason: string | null;
  persistedAt: string | null;
};

const terminalDatabaseV1 = () => {
  const rows = new Map<string, IntentRowV1>();
  const auditEvents: string[] = [];
  let stagedAudit: string | null = null;
  let stagedPersist: string | null = null;
  let auditFailures = 0;
  let updateFailures = 0;
  let reserveFailures = 0;
  const connection = {
    async query() {
      return [[], []];
    },
    async beginTransaction() {
      stagedAudit = null;
      stagedPersist = null;
    },
    async commit() {
      if (stagedAudit !== null) auditEvents.push(stagedAudit);
      if (stagedPersist !== null) rows.get(stagedPersist)!.persistedAt = '2026-08-02 00:00:00.000';
      stagedAudit = null;
      stagedPersist = null;
    },
    async rollback() {
      stagedAudit = null;
      stagedPersist = null;
    },
    async execute(sql: string, values: readonly unknown[] = []) {
      const normalized = sql.replace(/\s+/gu, ' ').trim();
      if (normalized.startsWith('INSERT INTO export_terminal_audit_intents')) {
        if (reserveFailures > 0) {
          reserveFailures -= 1;
          throw new Error('fixture terminal reservation failure');
        }
        const correlationId = String(values[0]);
        if (rows.has(correlationId)) return [{ affectedRows: 0 }, []];
        rows.set(correlationId, {
          correlationId,
          actorKind: values[1] as 'user' | 'service',
          actorPublicId: String(values[2]),
          format: values[3] as 'pdf' | 'pptx',
          revisionNumber: String(values[4]),
          outcome: 'pending',
          completedBytes: null,
          failureReason: null,
          persistedAt: null,
        });
        return [{ affectedRows: 1 }, []];
      }
      if (normalized.includes('AS ambiguousCount')) {
        return [
          [
            {
              ambiguousCount: String(
                [...rows.values()].filter((row) => row.outcome === 'pending').length,
              ),
            },
          ],
          [],
        ];
      }
      if (normalized.includes('ORDER BY terminal_audit_intent_pk')) {
        return [
          [...rows.values()].filter((row) => row.outcome !== 'pending' && row.persistedAt === null),
          [],
        ];
      }
      if (normalized.includes('FROM export_terminal_audit_intents')) {
        const row = rows.get(String(values[0]));
        return [row === undefined ? [] : [row], []];
      }
      if (normalized.startsWith('UPDATE export_terminal_audit_intents')) {
        if (normalized.includes('SET outcome = ?')) {
          const correlationId = String(values[3]);
          const row = rows.get(correlationId);
          if (
            row === undefined ||
            row.outcome !== 'pending' ||
            row.actorKind !== values[4] ||
            row.actorPublicId !== values[5] ||
            row.format !== values[6] ||
            row.revisionNumber !== String(values[7])
          )
            return [{ affectedRows: 0 }, []];
          row.outcome = values[0] as 'completed' | 'failed';
          row.completedBytes = values[1] === null ? null : String(values[1]);
          row.failureReason = values[2] === null ? null : String(values[2]);
          return [{ affectedRows: 1 }, []];
        }
        if (updateFailures > 0) {
          updateFailures -= 1;
          throw new Error('fixture crash before terminal intent completion');
        }
        const correlationId = String(values[0]);
        if (rows.get(correlationId)?.persistedAt !== null) return [{ affectedRows: 0 }, []];
        stagedPersist = correlationId;
        return [{ affectedRows: 1 }, []];
      }
      throw new Error(`unexpected SQL: ${normalized}`);
    },
    stageAudit(event: string) {
      if (auditFailures > 0) {
        auditFailures -= 1;
        throw new Error('fixture transient terminal audit failure');
      }
      stagedAudit = event;
    },
  };
  const audit = {
    async completedFromIntent(value: typeof connection, input: { bytes: number }) {
      value.stageAudit(`completed:${input.bytes}`);
    },
    async failedFromIntent(value: typeof connection, input: { reason: string }) {
      value.stageAudit(`failed:${input.reason}`);
    },
  };
  return {
    connection: connection as never,
    audit: audit as never,
    auditEvents,
    rows,
    failAudit(times = 1) {
      auditFailures = times;
    },
    failUpdate(times = 1) {
      updateFailures = times;
    },
    failReserve(times = 1) {
      reserveFailures = times;
    },
  };
};

const terminalReservationV1 = {
  actor: { principalKind: 'service' as const, principalId: 'key_1', grantId: null },
  correlationId: 'completed_1',
  format: 'pdf' as const,
  revisionNumber: 7,
};

const completedIntentV1 = {
  ...terminalReservationV1,
  outcome: 'completed' as const,
  bytes: 123,
};

test('pending terminal reservation is durable before finalization and surfaces after restart', async () => {
  const database = terminalDatabaseV1();
  const firstProcess = new ExportTerminalAuditRepositoryV1(database.audit);
  assert.equal(await firstProcess.reserve(database.connection, terminalReservationV1), 'pending');

  const restarted = new ExportTerminalAuditRepositoryV1(database.audit);
  assert.deepEqual(await restarted.recover(database.connection), {
    persisted: 0,
    ambiguous: 1,
  });
  assert.deepEqual(database.auditEvents, []);
  assert.equal(database.rows.get(terminalReservationV1.correlationId)?.outcome, 'pending');
});

test('persistent initial terminal reservation failure leaves no response-eligible intent', async () => {
  const database = terminalDatabaseV1();
  const repository = new ExportTerminalAuditRepositoryV1(database.audit);
  database.failReserve(2);
  await assert.rejects(repository.reserve(database.connection, terminalReservationV1));
  await assert.rejects(repository.reserve(database.connection, terminalReservationV1));
  assert.equal(database.rows.size, 0);
});

test('durable terminal intent survives transient audit failure and restart recovery', async () => {
  const database = terminalDatabaseV1();
  const firstProcess = new ExportTerminalAuditRepositoryV1(database.audit);
  await firstProcess.reserve(database.connection, terminalReservationV1);
  await firstProcess.finalize(database.connection, completedIntentV1);
  database.failAudit();
  await assert.rejects(firstProcess.persist(database.connection, completedIntentV1.correlationId));
  assert.equal(database.rows.get(completedIntentV1.correlationId)?.persistedAt, null);
  assert.deepEqual(database.auditEvents, []);

  const restarted = new ExportTerminalAuditRepositoryV1(database.audit);
  assert.deepEqual(await restarted.recover(database.connection), {
    persisted: 1,
    ambiguous: 0,
  });
  assert.deepEqual(database.auditEvents, ['completed:123']);
  assert.notEqual(database.rows.get(completedIntentV1.correlationId)?.persistedAt, null);
  assert.equal(
    await restarted.persist(database.connection, completedIntentV1.correlationId),
    false,
  );
  assert.deepEqual(database.auditEvents, ['completed:123']);
});

test('terminal audit transaction rolls back the event when completion marking crashes', async () => {
  const database = terminalDatabaseV1();
  const repository = new ExportTerminalAuditRepositoryV1(database.audit);
  const failedIntent = {
    ...terminalReservationV1,
    correlationId: 'failed_1',
    outcome: 'failed' as const,
    reason: 'EXPORT_ENCODE_FAILED' as const,
  };
  await repository.reserve(database.connection, failedIntent);
  await repository.finalize(database.connection, failedIntent);
  database.failUpdate();
  await assert.rejects(repository.persist(database.connection, failedIntent.correlationId));
  assert.deepEqual(database.auditEvents, []);
  assert.deepEqual(await repository.recover(database.connection), {
    persisted: 1,
    ambiguous: 0,
  });
  assert.deepEqual(database.auditEvents, ['failed:EXPORT_ENCODE_FAILED']);
});

test('terminal audit finalization is idempotent only for an identical immutable outcome payload', async () => {
  const database = terminalDatabaseV1();
  const repository = new ExportTerminalAuditRepositoryV1(database.audit);
  assert.equal(await repository.reserve(database.connection, terminalReservationV1), 'pending');
  assert.equal(
    await repository.finalize(database.connection, completedIntentV1),
    completedIntentV1.outcome,
  );
  assert.equal(
    await repository.finalize(database.connection, { ...completedIntentV1 }),
    completedIntentV1.outcome,
  );
  for (const conflicting of [
    {
      ...completedIntentV1,
      actor: { principalKind: 'service' as const, principalId: 'key_2', grantId: null },
    },
    { ...completedIntentV1, format: 'pptx' as const },
    { ...completedIntentV1, revisionNumber: 8 },
    { ...completedIntentV1, bytes: 124 },
    {
      ...completedIntentV1,
      outcome: 'failed' as const,
      reason: 'EXPORT_ENCODE_FAILED' as const,
    },
  ]) {
    await assert.rejects(
      repository.finalize(database.connection, conflicting),
      BoardPersistenceError,
    );
  }
});

test('pending terminal audit finalizes to failed and emits its mandatory event exactly once', async () => {
  const database = terminalDatabaseV1();
  const repository = new ExportTerminalAuditRepositoryV1(database.audit);
  const failedIntent = {
    ...terminalReservationV1,
    correlationId: 'failed_exact_once',
    outcome: 'failed' as const,
    reason: 'EXPORT_RENDER_TIMEOUT' as const,
  };
  await repository.reserve(database.connection, failedIntent);
  await repository.finalize(database.connection, failedIntent);
  await repository.finalize(database.connection, { ...failedIntent });
  assert.equal(await repository.persist(database.connection, failedIntent.correlationId), true);
  assert.equal(await repository.persist(database.connection, failedIntent.correlationId), false);
  assert.deepEqual(database.auditEvents, ['failed:EXPORT_RENDER_TIMEOUT']);
});

test('terminal audit recovery skips one corrupt finalized intent and persists its healthy sibling', async () => {
  const database = terminalDatabaseV1();
  const repository = new ExportTerminalAuditRepositoryV1(database.audit);
  await repository.reserve(database.connection, terminalReservationV1);
  await repository.finalize(database.connection, completedIntentV1);
  await repository.reserve(database.connection, {
    ...terminalReservationV1,
    correlationId: 'completed_2',
  });
  await repository.finalize(database.connection, {
    ...completedIntentV1,
    correlationId: 'completed_2',
    bytes: 456,
  });
  database.rows.get(completedIntentV1.correlationId)!.completedBytes = 'invalid';
  assert.deepEqual(await repository.recover(database.connection), {
    persisted: 1,
    ambiguous: 0,
  });
  assert.deepEqual(database.auditEvents, ['completed:456']);
  assert.equal(database.rows.get(completedIntentV1.correlationId)?.persistedAt, null);
  assert.notEqual(database.rows.get('completed_2')?.persistedAt, null);
});

test('export cleanup recovers terminal intents independently of hold cleanup failure', async () => {
  let terminalRecoveries = 0;
  const mysql = {
    async withConnection<T>(work: (connection: unknown) => Promise<T>) {
      return work({});
    },
  };
  const cleanup = new ExportCleanupServiceV1(
    mysql as never,
    {
      async recoverExpired() {
        throw new Error('fixture hold cleanup failure');
      },
    } as never,
    {
      async recover() {
        terminalRecoveries += 1;
        return 1;
      },
    } as never,
  );
  await cleanup.recover();
  assert.equal(terminalRecoveries, 1);
});
