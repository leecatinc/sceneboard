import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import type { BoardId } from '@sceneboard/board-schema';

import type { MysqlService } from '../../src/database/mysql.service.js';
import {
  awaitOwnedDatabaseOperation,
  DatabaseOperationAbortedError,
  type DatabaseOperationOwnershipV1,
} from '../../src/database/transaction.js';
import { ExportAdmissionServiceV1 } from '../../src/exports/export-admission.service.js';
import type { ExportAuditServiceV1 } from '../../src/exports/export-audit.service.js';
import type { ExportAuthorizationPolicyV1 } from '../../src/exports/export-authorization.policy.js';
import { ExportFailureV1 } from '../../src/exports/export-errors.js';
import type { ResolvedBoardPrincipalV1 } from '../../src/grants/board-access.policy.js';

const boardId = 'board_1' as BoardId;

// The production ownership timer is intentionally unref'ed. Keep this isolated fake-operation
// suite alive long enough to observe the deadline without depending on another test worker.
const admissionDeadlineKeepAlive = setInterval(() => undefined, 1_000);
after(() => clearInterval(admissionDeadlineKeepAlive));

const principal = (keyPk = 70n): ResolvedBoardPrincipalV1 =>
  ({
    kind: 'account_api_key',
    actor: { principalKind: 'service', principalId: `key_${keyPk}`, grantId: null, scopes: [] },
    ownerUserPk: keyPk - 50n,
    apiKeyPk: keyPk,
    scopeMask: 32,
    isBrowserCredential: false,
  }) as unknown as ResolvedBoardPrincipalV1;

const withoutUnhandledRejections = async (operation: () => Promise<void>): Promise<void> => {
  const unhandled: unknown[] = [];
  const handler = (reason: unknown): void => {
    unhandled.push(reason);
  };
  process.on('unhandledRejection', handler);
  try {
    await operation();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', handler);
  }
};

const setup = () => {
  let session = 0;
  let authorizationMode: 'success' | 'fail-after-apply' | 'retry-after-apply' | 'never' = 'success';
  let projectionFailure = false;
  let globalAdmission = true;
  let rendererFailure = false;
  let rendererCompleteFailures = 0;
  let rendererAbortFailures = 0;
  let globalReleaseFailures = 0;
  let completedAuditFailures = 0;
  let failedAuditFailures = 0;
  let terminalReservationFailures = 0;
  let deferredTerminalFinalize: Promise<never> | undefined;
  let rejectDeferredTerminalFinalize: ((error: Error) => void) | undefined;
  let deferredTerminalPersist: Promise<never> | undefined;
  let rejectDeferredTerminalPersist: ((error: Error) => void) | undefined;
  const auditEvents: string[] = [];
  const releaseEvents: string[] = [];
  const terminalFinalizeOwnerships: Array<DatabaseOperationOwnershipV1 | undefined> = [];
  const terminalPersistOwnerships: Array<DatabaseOperationOwnershipV1 | undefined> = [];
  let deferredGlobalAcquire: Promise<boolean> | undefined;
  let resolveGlobalAcquire: ((value: boolean) => void) | undefined;
  let deferredRenderer: Promise<unknown> | undefined;
  let resolveRenderer: ((value: unknown) => void) | undefined;
  const connection = {
    async execute() {
      return [[{ boardPk: '50', ownerUserPk: '20', title: 'Board' }], []];
    },
  };
  const authorization = {
    async authorize(input: { apply: (connection: unknown, context: unknown) => Promise<unknown> }) {
      if (authorizationMode === 'never') return new Promise<never>(() => undefined);
      const apply = () => input.apply(connection, { ownerUserPk: 20n });
      if (authorizationMode === 'retry-after-apply') {
        await apply();
        return apply();
      }
      const result = await apply();
      if (authorizationMode === 'fail-after-apply')
        throw new Error('post-apply authorization failed');
      return result;
    },
  } as unknown as ExportAuthorizationPolicyV1;
  const mysql = {
    withConnection: <T>(
      work: (value: unknown) => Promise<T>,
      ownership?: DatabaseOperationOwnershipV1,
    ) => {
      const ownedConnection = Object.assign(Object.create(connection), {
        operationOwnership: ownership,
      });
      return awaitOwnedDatabaseOperation(Promise.resolve(ownedConnection), ownership).then(
        (acquiredConnection) => awaitOwnedDatabaseOperation(work(acquiredConnection), ownership),
      );
    },
  } as unknown as MysqlService;
  const audit = {
    async started() {
      auditEvents.push('started');
    },
    async completed(_connection: unknown, input: { bytes: number }) {
      if (completedAuditFailures > 0) {
        completedAuditFailures -= 1;
        throw new Error('fixture completed audit failure');
      }
      auditEvents.push(`completed:${input.bytes}`);
    },
    async failed(_connection: unknown, input: { reason: string }) {
      if (failedAuditFailures > 0) {
        failedAuditFailures -= 1;
        throw new Error('fixture failed audit failure');
      }
      auditEvents.push(`failed:${input.reason}`);
    },
  } as unknown as ExportAuditServiceV1;
  const terminalIntents = new Map<
    string,
    { outcome: 'pending' | 'completed' | 'failed'; bytes?: number; reason?: string }
  >();
  const persistedIntents = new Set<string>();
  const terminalAudits = {
    async reserve(_connection: unknown, input: { correlationId: string }) {
      if (terminalReservationFailures > 0) {
        terminalReservationFailures -= 1;
        throw new Error('fixture terminal reservation failure');
      }
      const existing = terminalIntents.get(input.correlationId);
      if (existing !== undefined) return existing.outcome;
      terminalIntents.set(input.correlationId, { outcome: 'pending' });
      return 'pending' as const;
    },
    async finalize(
      terminalConnection: unknown,
      input: {
        correlationId: string;
        outcome: 'completed' | 'failed';
        bytes?: number;
        reason?: string;
      },
    ) {
      terminalFinalizeOwnerships.push(
        (terminalConnection as { operationOwnership?: DatabaseOperationOwnershipV1 })
          .operationOwnership,
      );
      const existing = terminalIntents.get(input.correlationId);
      if (existing === undefined) throw new Error('fixture terminal reservation missing');
      if (existing.outcome === 'pending') terminalIntents.set(input.correlationId, input);
      const finalized = terminalIntents.get(input.correlationId)!;
      if (
        finalized.outcome !== input.outcome ||
        finalized.bytes !== input.bytes ||
        finalized.reason !== input.reason
      )
        throw new Error('fixture conflicting terminal finalization');
      if (deferredTerminalFinalize !== undefined) {
        const deferred = deferredTerminalFinalize;
        deferredTerminalFinalize = undefined;
        return deferred;
      }
      return finalized.outcome;
    },
    async persist(terminalConnection: unknown, correlationId: string) {
      terminalPersistOwnerships.push(
        (terminalConnection as { operationOwnership?: DatabaseOperationOwnershipV1 })
          .operationOwnership,
      );
      if (deferredTerminalPersist !== undefined) {
        const deferred = deferredTerminalPersist;
        deferredTerminalPersist = undefined;
        return deferred;
      }
      if (persistedIntents.has(correlationId)) return false;
      const intent = terminalIntents.get(correlationId);
      if (intent === undefined) throw new Error('fixture terminal intent missing');
      if (intent.outcome === 'completed')
        await audit.completed({} as never, { bytes: intent.bytes } as never);
      else await audit.failed({} as never, { reason: intent.reason } as never);
      persistedIntents.add(correlationId);
      return true;
    },
  };
  const service = new ExportAdmissionServiceV1(
    authorization,
    {
      async project() {
        if (projectionFailure) throw new Error('projection failed');
        return {
          projection: { revisionNumber: 1 },
          projectionSha256: 'a'.repeat(64),
          hold: { boardPk: 50n, revisionPk: 60n },
        };
      },
    } as never,
    {
      issueCredentials() {
        session += 1;
        return { sessionId: `session_${session}`, accessToken: 'fixture' };
      },
      async open() {},
      async cancel() {},
    } as never,
    {
      register() {},
      async dispose() {},
    } as never,
    {
      async render() {
        if (rendererFailure) throw new Error('renderer failed');
        if (deferredRenderer !== undefined) return deferredRenderer;
        return {
          projection: { revisionNumber: 1 },
          async completeResponse() {
            if (rendererCompleteFailures > 0) {
              rendererCompleteFailures -= 1;
              throw new Error('fixture renderer completion failure');
            }
            releaseEvents.push('response:complete');
          },
          async abort() {
            if (rendererAbortFailures > 0) {
              rendererAbortFailures -= 1;
              throw new Error('fixture renderer abort failure');
            }
            releaseEvents.push('response:abort');
          },
        };
      },
    } as never,
    {
      async acquire() {
        if (deferredGlobalAcquire !== undefined) return deferredGlobalAcquire;
        return globalAdmission;
      },
      async release(sessionId: string) {
        if (globalReleaseFailures > 0) {
          globalReleaseFailures -= 1;
          throw new Error('fixture global release failure');
        }
        releaseEvents.push(`global:${sessionId}`);
      },
    } as never,
    {
      async renew() {},
      async release() {},
    } as never,
    audit,
    terminalAudits as never,
    mysql,
    {
      apiOrigin: 'http://127.0.0.1:3411',
      webOrigin: 'http://127.0.0.1:3000',
      artifactRuntimeOrigin: 'http://127.0.0.1:3412',
    },
  );
  return {
    service,
    auditEvents,
    releaseEvents,
    terminalFinalizeOwnerships,
    terminalPersistOwnerships,
    terminalIntent(correlationId: string) {
      return terminalIntents.get(correlationId);
    },
    persistedIntentCount() {
      return persistedIntents.size;
    },
    setAuthorizationMode(value: typeof authorizationMode) {
      authorizationMode = value;
    },
    setProjectionFailure(value: boolean) {
      projectionFailure = value;
    },
    setGlobalAdmission(value: boolean) {
      globalAdmission = value;
    },
    setRendererFailure(value: boolean) {
      rendererFailure = value;
    },
    setRendererCompleteFailures(value: number) {
      rendererCompleteFailures = value;
    },
    setRendererAbortFailures(value: number) {
      rendererAbortFailures = value;
    },
    setGlobalReleaseFailures(value: number) {
      globalReleaseFailures = value;
    },
    setCompletedAuditFailures(value: number) {
      completedAuditFailures = value;
    },
    setFailedAuditFailures(value: number) {
      failedAuditFailures = value;
    },
    setTerminalReservationFailures(value: number) {
      terminalReservationFailures = value;
    },
    deferNextTerminalFinalize() {
      deferredTerminalFinalize = new Promise<never>((_resolve, reject) => {
        rejectDeferredTerminalFinalize = reject;
      });
      return (error: Error): void => rejectDeferredTerminalFinalize?.(error);
    },
    deferNextTerminalPersist() {
      deferredTerminalPersist = new Promise<never>((_resolve, reject) => {
        rejectDeferredTerminalPersist = reject;
      });
      return (error: Error): void => rejectDeferredTerminalPersist?.(error);
    },
    deferGlobalAcquire() {
      deferredGlobalAcquire = new Promise<boolean>((resolve) => {
        resolveGlobalAcquire = resolve;
      });
      return (value: boolean): void => resolveGlobalAcquire?.(value);
    },
    deferRenderer() {
      deferredRenderer = new Promise<unknown>((resolve) => {
        resolveRenderer = resolve;
      });
      return (value: unknown): void => resolveRenderer?.(value);
    },
  };
};

const admit = (
  value: ReturnType<typeof setup>,
  actor = principal(),
  timing?: { signal: AbortSignal; deadlineMs: number },
) =>
  value.service.admit({
    principal: actor,
    boardId,
    request: { format: 'pdf', revisionId: null },
    correlationId: 'request_1',
    signal: timing?.signal ?? new AbortController().signal,
    deadlineMs: timing?.deadlineMs ?? Date.now() + 120_000,
  });

test('reservation ownership survives post-apply failures and transaction retries', async () => {
  for (const failure of ['fail-after-apply', 'projection', 'global', 'renderer'] as const) {
    const value = setup();
    if (failure === 'fail-after-apply') value.setAuthorizationMode('fail-after-apply');
    if (failure === 'projection') value.setProjectionFailure(true);
    if (failure === 'global') value.setGlobalAdmission(false);
    if (failure === 'renderer') value.setRendererFailure(true);
    await assert.rejects(admit(value));
    value.setAuthorizationMode('success');
    value.setProjectionFailure(false);
    value.setGlobalAdmission(true);
    value.setRendererFailure(false);
    const lease = await admit(value);
    await lease.abort();
  }

  const retried = setup();
  retried.setAuthorizationMode('retry-after-apply');
  const lease = await admit(retried);
  await lease.abort();
});

test('admission fails before returning a response-eligible lease when terminal reservation fails', async () => {
  const value = setup();
  value.setTerminalReservationFailures(3);
  await assert.rejects(admit(value), /terminal reservation failure/u);
  assert.equal(value.auditEvents.filter((event) => event === 'started').length, 1);
  assert.equal(value.releaseEvents.filter((event) => event.startsWith('global:')).length, 1);
});

test('a never-settling authorization is bounded by the owned admission deadline', async () => {
  const value = setup();
  value.setAuthorizationMode('never');
  const startedAt = Date.now();
  await assert.rejects(
    admit(value, principal(), {
      signal: new AbortController().signal,
      deadlineMs: Date.now() + 20,
    }),
    (error: unknown) => error instanceof ExportFailureV1 && error.code === 'EXPORT_RENDER_TIMEOUT',
  );
  assert.ok(Date.now() - startedAt < 500);
});

test('late global and renderer ownership retries rejected cleanup without unhandled rejection', async () => {
  await withoutUnhandledRejections(async () => {
    const global = setup();
    global.setGlobalReleaseFailures(1);
    const resolveGlobal = global.deferGlobalAcquire();
    const globalAdmission = admit(global, principal(), {
      signal: new AbortController().signal,
      deadlineMs: Date.now() + 20,
    });
    await assert.rejects(
      globalAdmission,
      (error: unknown) =>
        error instanceof ExportFailureV1 && error.code === 'EXPORT_RENDER_TIMEOUT',
    );
    resolveGlobal(true);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(global.releaseEvents.filter((event) => event.startsWith('global:')).length, 1);

    const renderer = setup();
    renderer.setRendererAbortFailures(1);
    const resolveRenderer = renderer.deferRenderer();
    const rendererAdmission = admit(renderer, principal(), {
      signal: new AbortController().signal,
      deadlineMs: Date.now() + 20,
    });
    await assert.rejects(
      rendererAdmission,
      (error: unknown) =>
        error instanceof ExportFailureV1 && error.code === 'EXPORT_RENDER_TIMEOUT',
    );
    resolveRenderer({
      projection: { revisionNumber: 1 },
      async completeResponse() {},
      async abort() {
        if (renderer.releaseEvents.includes('late-renderer:first')) {
          renderer.releaseEvents.push('response:abort');
          return;
        }
        renderer.releaseEvents.push('late-renderer:first');
        throw new Error('fixture late renderer abort failure');
      },
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(renderer.releaseEvents.filter((event) => event === 'response:abort').length, 1);
  });
});

test('repeated cleanup cannot release a later reservation with the same keys', async () => {
  const value = setup();
  const first = await admit(value);
  await first.abort();
  const second = await admit(value);
  await first.abort();
  await assert.rejects(
    admit(value),
    (error: unknown) => error instanceof ExportFailureV1 && error.code === 'EXPORT_RATE_LIMITED',
  );
  await second.abort();
  const third = await admit(value);
  await third.abort();
});

test('completion is audited only after response delivery and terminal audit calls write once', async () => {
  const completed = setup();
  const completedLease = await admit(completed);
  await completedLease.auditCompleted(123);
  assert.equal(completed.auditEvents.includes('completed:123'), false);
  await Promise.all([completedLease.completeResponse(), completedLease.completeResponse()]);
  assert.deepEqual(
    completed.auditEvents.filter((event) => event !== 'started'),
    ['completed:123'],
  );
  await completedLease.auditFailed('EXPORT_ENCODE_FAILED');
  assert.deepEqual(
    completed.auditEvents.filter((event) => event !== 'started'),
    ['completed:123'],
  );

  const failed = setup();
  const failedLease = await admit(failed);
  await failedLease.auditCompleted(456);
  await Promise.all([
    failedLease.auditFailed('EXPORT_ENCODE_FAILED'),
    failedLease.auditFailed('EXPORT_RENDER_TIMEOUT'),
  ]);
  await failedLease.abort();
  assert.deepEqual(
    failed.auditEvents.filter((event) => event !== 'started'),
    ['failed:EXPORT_ENCODE_FAILED'],
  );
});

test('delivered cleanup and completion audit failures remain retryable without a failed rewrite', async () => {
  const value = setup();
  value.setRendererCompleteFailures(1);
  value.setGlobalReleaseFailures(1);
  value.setCompletedAuditFailures(1);
  const lease = await admit(value);
  await lease.auditCompleted(789);
  await assert.rejects(lease.completeResponse());
  await lease.completeResponse();
  await lease.auditFailed('EXPORT_ENCODE_FAILED');
  assert.deepEqual(
    value.auditEvents.filter((event) => event !== 'started'),
    ['completed:789'],
  );
  assert.equal(value.releaseEvents.filter((event) => event === 'response:complete').length, 1);
  assert.equal(value.releaseEvents.filter((event) => event.startsWith('global:')).length, 1);
});

test('a rejected failed audit attempt can be retried without duplicating its terminal event', async () => {
  const value = setup();
  value.setFailedAuditFailures(1);
  const lease = await admit(value);
  await assert.rejects(lease.auditFailed('EXPORT_RENDER_TIMEOUT'));
  await lease.auditFailed('EXPORT_ENCODE_FAILED');
  await lease.abort();
  assert.deepEqual(
    value.auditEvents.filter((event) => event !== 'started'),
    ['failed:EXPORT_RENDER_TIMEOUT'],
  );
});

test('failed terminal finalize is cleanup-owned, bounded, immutable, and retryable', async () => {
  await withoutUnhandledRejections(async () => {
    const value = setup();
    const requestDeadlineMs = Date.now() + 30;
    const lease = await admit(value, principal(), {
      signal: new AbortController().signal,
      deadlineMs: requestDeadlineMs,
    });
    const rejectLateFinalize = value.deferNextTerminalFinalize();
    const startedAt = Date.now();
    const failedAudit = lease.auditFailed('EXPORT_ENCODE_FAILED');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(value.terminalFinalizeOwnerships.length, 1);
    const cleanupOwnership = value.terminalFinalizeOwnerships[0];
    assert.ok((cleanupOwnership?.deadlineMs ?? 0) > requestDeadlineMs);
    assert.ok((cleanupOwnership?.deadlineMs ?? 0) >= startedAt + 900);
    assert.ok((cleanupOwnership?.deadlineMs ?? 0) <= startedAt + 1_100);
    assert.equal(cleanupOwnership?.cleanupGraceMs, 1_000);
    assert.equal(cleanupOwnership?.signal instanceof AbortSignal, true);
    assert.equal(cleanupOwnership?.signal.aborted, false);
    await assert.rejects(
      failedAudit,
      (error: unknown) => error instanceof DatabaseOperationAbortedError,
    );
    assert.ok(Date.now() - startedAt < 1_500);
    assert.deepEqual(value.terminalIntent('request_1'), {
      actor: principal().actor,
      correlationId: 'request_1',
      format: 'pdf',
      revisionNumber: 1,
      outcome: 'failed',
      reason: 'EXPORT_ENCODE_FAILED',
    });
    assert.equal(value.persistedIntentCount(), 0);
    rejectLateFinalize(new Error('fixture late terminal finalize rejection'));
    await new Promise((resolve) => setImmediate(resolve));
    await lease.auditFailed('EXPORT_RENDER_TIMEOUT');
    await lease.abort();
    assert.equal(value.persistedIntentCount(), 1);
    assert.deepEqual(
      value.auditEvents.filter((event) => event !== 'started'),
      ['failed:EXPORT_ENCODE_FAILED'],
    );
  });
});

test('rolled-back admission does not finalize a missing terminal reservation', async () => {
  await withoutUnhandledRejections(async () => {
    const value = setup();
    value.setAuthorizationMode('fail-after-apply');
    const requestDeadlineMs = Date.now() + 30;
    const startedAt = Date.now();
    await assert.rejects(
      admit(value, principal(), {
        signal: new AbortController().signal,
        deadlineMs: requestDeadlineMs,
      }),
    );
    assert.ok(Date.now() - startedAt < 1_500);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(value.terminalFinalizeOwnerships.length, 0);
    assert.equal(value.terminalPersistOwnerships.length, 0);
    assert.equal(value.persistedIntentCount(), 0);
    assert.deepEqual(
      value.auditEvents.filter((event) => event !== 'started'),
      [],
    );
  });
});
