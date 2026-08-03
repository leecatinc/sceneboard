import { randomBytes } from 'node:crypto';

import type { BoardId, RevisionId } from '@sceneboard/board-schema';
import type { PoolConnection, RowDataPacket } from 'mysql2/promise';

import type { MysqlService } from '../database/mysql.service.js';
import type { ResolvedBoardPrincipalV1 } from '../grants/board-access.policy.js';
import { ExportAuditServiceV1 } from './export-audit.service.js';
import { ExportAuthorizationPolicyV1 } from './export-authorization.policy.js';
import { ExportFailureV1, type ExportFailureCodeV1 } from './export-errors.js';
import {
  EXPORT_GLOBAL_LEASE_MS_V1,
  exportGlobalAdmissionHolderIdV1,
  ExportGlobalAdmissionRepositoryV1,
  type ExportGlobalAdmissionLeaseV1,
} from './export-global-admission.repository.js';
import { ExportProjectionServiceV1 } from './export-projection.service.js';
import { ExportRenderBrokerServiceV1 } from './export-render-broker.service.js';
import type { ExportRenderLeaseV1 } from './export-renderer.service.js';
import { ExportRendererServiceV1 } from './export-renderer.service.js';
import { ExportRenderSessionRepositoryV1 } from './export-render-session.repository.js';
import {
  EXPORT_HOLD_RENEW_SECONDS_V1,
  ExportRevisionHoldRepositoryV1,
} from './export-revision-hold.repository.js';
import {
  ExportTerminalAuditRepositoryV1,
  type ExportTerminalAuditIntentV1,
} from './export-terminal-audit.repository.js';
import { ExportRequestSchemaV1 } from './export-request.schema.js';
import type { ExportFormatV1 } from './export-request.schema.js';

interface BoardRow extends RowDataPacket {
  boardPk: string;
  ownerUserPk: string;
  title: string;
}

const databasePk = (value: string): bigint => {
  if (!/^[1-9][0-9]{0,19}$/u.test(value)) throw new ExportFailureV1('EXPORT_INTERNAL_ERROR');
  const parsed = BigInt(value);
  if (parsed > 18_446_744_073_709_551_615n) throw new ExportFailureV1('EXPORT_INTERNAL_ERROR');
  return parsed;
};

const reportCleanupFailure = (error: unknown): void => {
  process.emitWarning(error instanceof Error ? error : new Error(String(error)), {
    code: 'SCENEBOARD_EXPORT_CLEANUP_FAILED',
  });
};

type ExportAdmissionRuntimeV1 = Readonly<{
  now(): number;
  scheduleInterval(operation: () => void, intervalMs: number): () => void;
  wait(milliseconds: number): Promise<void>;
}>;

const DEFAULT_EXPORT_ADMISSION_RUNTIME_V1: ExportAdmissionRuntimeV1 = Object.freeze({
  now: () => Date.now(),
  scheduleInterval: (operation, intervalMs) => {
    const timer = setInterval(operation, intervalMs);
    timer.unref();
    return () => clearInterval(timer);
  },
  wait: (milliseconds) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, milliseconds);
      timer.unref();
    }),
});

const ownedOperationFailure = (signal: AbortSignal): ExportFailureV1 =>
  signal.reason instanceof ExportFailureV1
    ? signal.reason
    : new ExportFailureV1('EXPORT_RENDER_TIMEOUT');

const retryDetachedCleanup = async (operation: () => void | Promise<void>): Promise<void> => {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await operation();
      return;
    } catch (error) {
      lastError = error;
    }
  }
  reportCleanupFailure(lastError);
};

const settleDetachedCleanup = async (
  operations: readonly (() => void | Promise<void>)[],
): Promise<void> => {
  let timeout: NodeJS.Timeout | undefined;
  await Promise.race([
    Promise.all(operations.map((operation) => retryDetachedCleanup(operation))),
    new Promise<void>((resolve) => {
      timeout = setTimeout(resolve, 1_000);
      timeout.unref();
    }),
  ]);
  if (timeout !== undefined) clearTimeout(timeout);
};

const awaitOwnedOperation = <T>(
  operation: Promise<T>,
  signal: AbortSignal,
  deadlineMs: number,
  releaseLateResult?: (value: T) => void | Promise<void>,
): Promise<T> =>
  new Promise((resolve, reject) => {
    let terminal = false;
    const cleanup = (): void => {
      clearTimeout(timeout);
      signal.removeEventListener('abort', aborted);
    };
    const fail = (): void => {
      if (terminal) return;
      terminal = true;
      cleanup();
      reject(ownedOperationFailure(signal));
    };
    const aborted = (): void => fail();
    const timeout = setTimeout(fail, Math.max(1, deadlineMs - Date.now()));
    timeout.unref();
    signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted || Date.now() >= deadlineMs) fail();
    void operation.then(
      (value) => {
        if (terminal) {
          if (releaseLateResult !== undefined)
            void settleDetachedCleanup([() => releaseLateResult(value)]).catch(
              reportCleanupFailure,
            );
          return;
        }
        terminal = true;
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        if (terminal) return;
        terminal = true;
        cleanup();
        reject(error);
      },
    );
  });

const retryableCleanup = (cleanup: () => Promise<void>): (() => Promise<void>) => {
  let completed = false;
  let inFlight: Promise<void> | undefined;
  return async (): Promise<void> => {
    if (completed) return;
    if (inFlight !== undefined) return inFlight;
    let attempt: Promise<void>;
    try {
      attempt = cleanup().then(() => {
        completed = true;
      });
    } catch (error) {
      attempt = Promise.reject(error);
    }
    inFlight = attempt;
    try {
      await attempt;
    } finally {
      if (inFlight === attempt) inFlight = undefined;
    }
  };
};

const assertOwnedOperationActive = (signal: AbortSignal, deadlineMs: number): void => {
  if (signal.aborted) throw ownedOperationFailure(signal);
  if (Date.now() >= deadlineMs) throw new ExportFailureV1('EXPORT_RENDER_TIMEOUT');
};

const EXPORT_CLEANUP_GRACE_MS_V1 = 1_000;

const createTerminalAuditCleanupOwnership = () =>
  Object.freeze({
    signal: new AbortController().signal,
    deadlineMs: Date.now() + EXPORT_CLEANUP_GRACE_MS_V1,
    cleanupGraceMs: EXPORT_CLEANUP_GRACE_MS_V1,
  });

const settleCleanupOperations = async (
  operations: readonly (() => Promise<void>)[],
): Promise<readonly unknown[]> => {
  const failures: unknown[] = [];
  let timeout: NodeJS.Timeout | undefined;
  let timedOut = false;
  const settled = Promise.all(
    operations.map(async (operation) => {
      try {
        await operation();
      } catch (error) {
        failures.push(error);
      }
    }),
  );
  await Promise.race([
    settled,
    new Promise<void>((resolve) => {
      timeout = setTimeout(() => {
        timedOut = true;
        resolve();
      }, EXPORT_CLEANUP_GRACE_MS_V1);
    }),
  ]);
  if (timeout !== undefined) clearTimeout(timeout);
  if (timedOut) failures.push(new ExportFailureV1('EXPORT_INTERNAL_ERROR'));
  return failures;
};

export type ExportRuntimeOriginsV1 = Readonly<{
  apiOrigin: string;
  webOrigin: string;
  artifactRuntimeOrigin: string;
}>;

export type ExportAdmittedLeaseV1 = ExportRenderLeaseV1 &
  Readonly<{
    boardTitle: string;
    auditCompleted(bytes: number): Promise<void>;
    auditFailed(reason: ExportFailureCodeV1): Promise<void>;
  }>;

export class ExportAdmissionServiceV1 {
  private readonly activeAccounts = new Set<string>();
  private readonly activeBoards = new Set<string>();
  private readonly activeCredentials = new Set<string>();

  constructor(
    private readonly authorization: ExportAuthorizationPolicyV1,
    private readonly projections: ExportProjectionServiceV1,
    private readonly sessions: ExportRenderSessionRepositoryV1,
    private readonly broker: ExportRenderBrokerServiceV1,
    private readonly renderer: ExportRendererServiceV1,
    private readonly globalAdmission: ExportGlobalAdmissionRepositoryV1,
    private readonly holds: ExportRevisionHoldRepositoryV1,
    private readonly audit: ExportAuditServiceV1,
    private readonly terminalAudits: ExportTerminalAuditRepositoryV1,
    private readonly mysql: MysqlService,
    private readonly origins: ExportRuntimeOriginsV1,
    private readonly runtime: ExportAdmissionRuntimeV1 = DEFAULT_EXPORT_ADMISSION_RUNTIME_V1,
  ) {}

  async admit(input: {
    principal: ResolvedBoardPrincipalV1;
    boardId: BoardId;
    request: unknown;
    correlationId: string;
    signal: AbortSignal;
    deadlineMs: number;
  }): Promise<ExportAdmittedLeaseV1> {
    const parsed = ExportRequestSchemaV1.safeParse(input.request);
    if (!parsed.success) throw new ExportFailureV1('EXPORT_INVALID_REQUEST');
    assertOwnedOperationActive(input.signal, input.deadlineMs);
    const credentials = this.sessions.issueCredentials();
    const globalLease: ExportGlobalAdmissionLeaseV1 = Object.freeze({
      sessionId: credentials.sessionId,
      generation: randomBytes(16).toString('base64url'),
    });
    const holdOwnerId = exportGlobalAdmissionHolderIdV1(globalLease);
    const ownershipAbortController = new AbortController();
    const operationSignal = AbortSignal.any([input.signal, ownershipAbortController.signal]);
    let releaseReservation: (() => void) | undefined;
    let bundle: Awaited<ReturnType<ExportProjectionServiceV1['project']>> | undefined;
    let globalLeaseState: 'active' | 'lost' | 'releasing' | 'released' = 'released';
    let globalLeaseSafeExpiryMs = 0;
    let globalReleaseInFlight: Promise<void> | undefined;
    let globalRenewalInFlight: Promise<boolean> | undefined;
    let stopGlobalRenewal: (() => void) | undefined;
    let rendererOwnsRuntime = false;
    let authorizationCleanupDetached = false;
    let terminalAuditReservationCommitted = false;
    let auditContext:
      | {
          principal: ResolvedBoardPrincipalV1;
          correlationId: string;
          format: ExportFormatV1;
          revisionNumber: number;
        }
      | undefined;
    const releaseLocalReservation = (): void => {
      releaseReservation?.();
      releaseReservation = undefined;
    };
    const stopGlobalRenewalHeartbeat = (): void => {
      stopGlobalRenewal?.();
      stopGlobalRenewal = undefined;
    };
    const markGlobalLeaseLost = (error: unknown, memberAbsent: boolean): void => {
      if (globalLeaseState !== 'active') return;
      globalLeaseState = 'lost';
      stopGlobalRenewalHeartbeat();
      if (memberAbsent) globalLeaseSafeExpiryMs = this.runtime.now();
      reportCleanupFailure(error);
      ownershipAbortController.abort(new ExportFailureV1('EXPORT_RENDERER_UNAVAILABLE', error));
    };
    const renewGlobalLease = async (): Promise<boolean> => {
      if (globalLeaseState !== 'active') return false;
      if (globalRenewalInFlight !== undefined) return globalRenewalInFlight;
      const attempt = this.globalAdmission.renew(globalLease);
      globalRenewalInFlight = attempt;
      try {
        const renewed = await attempt;
        if (renewed) globalLeaseSafeExpiryMs = this.runtime.now() + EXPORT_GLOBAL_LEASE_MS_V1;
        else markGlobalLeaseLost(new Error('export global admission renewal was rejected'), true);
        return renewed;
      } catch (error) {
        markGlobalLeaseLost(error, false);
        throw error;
      } finally {
        if (globalRenewalInFlight === attempt) globalRenewalInFlight = undefined;
      }
    };
    const releaseGlobalLease = async (): Promise<void> => {
      if (globalLeaseState === 'released') return;
      if (globalReleaseInFlight !== undefined) return globalReleaseInFlight;
      globalLeaseState = 'releasing';
      stopGlobalRenewalHeartbeat();
      const attempt = (async () => {
        let lastError: unknown;
        let attemptsSinceWait = 0;
        await globalRenewalInFlight?.catch(() => undefined);
        while (globalLeaseState === 'releasing') {
          try {
            await this.globalAdmission.release(globalLease);
            lastError = undefined;
            globalLeaseState = 'released';
            break;
          } catch (error) {
            lastError = error;
            attemptsSinceWait += 1;
            const remainingMs = globalLeaseSafeExpiryMs - this.runtime.now();
            if (remainingMs <= 0) {
              globalLeaseState = 'released';
              break;
            }
            if (attemptsSinceWait < 2) continue;
            attemptsSinceWait = 0;
            await this.runtime.wait(Math.min(1_000, remainingMs));
          }
        }
        if (lastError !== undefined && this.runtime.now() >= globalLeaseSafeExpiryMs)
          reportCleanupFailure(lastError);
      })();
      globalReleaseInFlight = attempt;
      try {
        await attempt;
      } finally {
        if (globalReleaseInFlight === attempt) globalReleaseInFlight = undefined;
      }
    };
    const startGlobalRenewal = (): void => {
      if (stopGlobalRenewal !== undefined || globalLeaseState !== 'active') return;
      stopGlobalRenewal = this.runtime.scheduleInterval(() => {
        if (globalLeaseState !== 'active') return;
        void renewGlobalLease().catch(() => undefined);
      }, EXPORT_HOLD_RENEW_SECONDS_V1 * 1_000);
    };
    const releaseAdmissionOwnership = async (): Promise<void> => {
      if (globalLeaseState !== 'released') await releaseGlobalLease();
      releaseLocalReservation();
    };
    const retryOwnedCleanupUntilTerminal = async (
      operation: () => void | Promise<void>,
    ): Promise<void> => {
      for (;;) {
        try {
          await operation();
          return;
        } catch (error) {
          reportCleanupFailure(error);
          await this.runtime.wait(1_000);
        }
      }
    };
    let terminalAuditPersisted = false;
    let terminalAuditJob: Promise<void> | undefined;
    const persistKnownTerminalAudit = (intent: ExportTerminalAuditIntentV1): Promise<void> => {
      if (terminalAuditPersisted) return Promise.resolve();
      if (terminalAuditJob !== undefined) return terminalAuditJob;
      const attempt = async (): Promise<void> => {
        const terminalAuditOwnership = createTerminalAuditCleanupOwnership();
        await this.mysql.withConnection(
          (connection) => this.terminalAudits.finalize(connection, intent),
          terminalAuditOwnership,
        );
        await this.mysql.withConnection(
          (connection) =>
            this.terminalAudits.persist(connection, intent.correlationId).then(() => undefined),
          terminalAuditOwnership,
        );
        terminalAuditPersisted = true;
      };
      const firstAttempt = attempt();
      terminalAuditJob = (async () => {
        let currentAttempt = firstAttempt;
        for (;;) {
          try {
            await currentAttempt;
            return;
          } catch (error) {
            reportCleanupFailure(error);
            await this.runtime.wait(1_000);
            currentAttempt = attempt();
          }
        }
      })();
      void terminalAuditJob.catch(reportCleanupFailure);
      return firstAttempt;
    };
    const reconcileProjectionOwnership = retryableCleanup(async () => {
      const ownedBundle = bundle;
      if (ownedBundle !== undefined && !rendererOwnsRuntime)
        await retryOwnedCleanupUntilTerminal(() =>
          this.mysql.withConnection((connection) =>
            this.holds.release(connection, ownedBundle.hold).then(() => undefined),
          ),
        );
      await releaseAdmissionOwnership();
    });
    const persistAdmissionFailure = async (error: unknown): Promise<void> => {
      const failedAudit = auditContext;
      if (failedAudit === undefined || !terminalAuditReservationCommitted) return;
      const reason = error instanceof ExportFailureV1 ? error.code : 'EXPORT_INTERNAL_ERROR';
      const intent = {
        actor: failedAudit.principal.actor,
        correlationId: failedAudit.correlationId,
        format: failedAudit.format,
        revisionNumber: failedAudit.revisionNumber,
        outcome: 'failed' as const,
        reason,
      };
      await persistKnownTerminalAudit(intent);
    };
    const releaseFailedRendererOwnership = (): Promise<void> => releaseAdmissionOwnership();
    try {
      const authorizationOperation = this.authorization.authorize({
        principal: input.principal,
        boardId: input.boardId,
        signal: operationSignal,
        deadlineMs: input.deadlineMs,
        retainTransactionUntilApplySettles: true,
        apply: async (connection, context) => {
          assertOwnedOperationActive(operationSignal, input.deadlineMs);
          releaseLocalReservation();
          bundle = undefined;
          auditContext = undefined;
          terminalAuditReservationCommitted = false;
          releaseReservation = this.reserve(input.principal, input.boardId);
          const board = await this.board(connection, input.boardId, context.ownerUserPk);
          assertOwnedOperationActive(operationSignal, input.deadlineMs);
          if (globalLeaseState === 'released') {
            const acquired = await this.globalAdmission.acquire(globalLease);
            if (!acquired) throw new ExportFailureV1('EXPORT_RATE_LIMITED');
            globalLeaseState = 'active';
            globalLeaseSafeExpiryMs = this.runtime.now() + EXPORT_GLOBAL_LEASE_MS_V1;
            assertOwnedOperationActive(operationSignal, input.deadlineMs);
            startGlobalRenewal();
          }
          if (globalLeaseState !== 'active')
            throw new ExportFailureV1('EXPORT_RENDERER_UNAVAILABLE');
          const projected = await this.projections.project(connection, {
            boardPk: board.boardPk,
            boardId: input.boardId,
            revisionId: parsed.data.revisionId as RevisionId | null,
            sessionId: credentials.sessionId,
            holdOwnerId,
          });
          bundle = projected;
          assertOwnedOperationActive(operationSignal, input.deadlineMs);
          auditContext = {
            principal: input.principal,
            correlationId: input.correlationId,
            format: parsed.data.format,
            revisionNumber: projected.projection.revisionNumber,
          };
          await this.audit.started(connection, auditContext);
          await this.terminalAudits.reserve(connection, {
            actor: auditContext.principal.actor,
            correlationId: auditContext.correlationId,
            format: auditContext.format,
            revisionNumber: auditContext.revisionNumber,
          });
          assertOwnedOperationActive(operationSignal, input.deadlineMs);
          return {
            bundle: projected,
            boardTitle: board.title,
          };
        },
      });
      let authorizationSettled = false;
      const observedAuthorization = authorizationOperation.then(
        (value) => {
          authorizationSettled = true;
          terminalAuditReservationCommitted = true;
          return value;
        },
        (error: unknown) => {
          authorizationSettled = true;
          throw error;
        },
      );
      let authorized: Awaited<typeof authorizationOperation>;
      try {
        authorized = await awaitOwnedOperation(
          observedAuthorization,
          operationSignal,
          input.deadlineMs,
        );
      } catch (error) {
        if (!authorizationSettled) {
          authorizationCleanupDetached = true;
          void observedAuthorization
            .then(
              (lateAuthorized) => {
                bundle = lateAuthorized.bundle;
                return Promise.allSettled([
                  retryDetachedCleanup(() => persistAdmissionFailure(error)),
                  reconcileProjectionOwnership(),
                ]).then(() => undefined);
              },
              () =>
                Promise.allSettled([
                  retryDetachedCleanup(() => persistAdmissionFailure(error)),
                  reconcileProjectionOwnership(),
                ]).then(() => undefined),
            )
            .catch(reportCleanupFailure);
        }
        throw error;
      }
      const admittedBundle = authorized.bundle;
      bundle = admittedBundle;
      await awaitOwnedOperation(
        this.sessions.open({
          ...credentials,
          boardPk: admittedBundle.hold.boardPk,
          revisionPk: admittedBundle.hold.revisionPk,
          projectionSha256: admittedBundle.projectionSha256,
          apiOrigin: this.origins.apiOrigin,
          webOrigin: this.origins.webOrigin,
          openedAtMs: Date.now(),
        }),
        operationSignal,
        input.deadlineMs,
        () => this.sessions.cancel({ ...credentials, nowMs: Date.now() }),
      );
      assertOwnedOperationActive(operationSignal, input.deadlineMs);
      this.broker.register({
        sessionId: credentials.sessionId,
        bundle: admittedBundle,
        webOrigin: this.origins.webOrigin,
      });
      const lease = await awaitOwnedOperation(
        this.renderer.render({
          credentials,
          bundle: admittedBundle,
          apiOrigin: this.origins.apiOrigin,
          webOrigin: this.origins.webOrigin,
          artifactRuntimeOrigin: this.origins.artifactRuntimeOrigin,
          signal: operationSignal,
          deadlineMs: input.deadlineMs,
          renewHold: () =>
            this.mysql.withConnection((renewConnection) =>
              this.holds.renew(renewConnection, admittedBundle.hold),
            ),
          releaseHold: () =>
            this.mysql.withConnection((releaseConnection) =>
              this.holds.release(releaseConnection, admittedBundle.hold).then(() => undefined),
            ),
          acceptOwnership: () => {
            rendererOwnsRuntime = true;
          },
          releaseFailedOwnership: releaseFailedRendererOwnership,
        }),
        operationSignal,
        input.deadlineMs,
        async (lateLease) => {
          await lateLease.abort();
          await releaseFailedRendererOwnership();
        },
      );
      const admittedAudit = auditContext;
      if (admittedAudit === undefined) throw new ExportFailureV1('EXPORT_INTERNAL_ERROR');
      const rendererOwnershipSignal =
        lease.ownershipSignal instanceof AbortSignal ? lease.ownershipSignal : operationSignal;
      const admittedOwnershipSignal = AbortSignal.any([operationSignal, rendererOwnershipSignal]);
      const assertDeliveryOwnership = (): void => {
        assertOwnedOperationActive(admittedOwnershipSignal, input.deadlineMs);
        if (globalLeaseState !== 'active') throw new ExportFailureV1('EXPORT_RENDERER_UNAVAILABLE');
        lease.assertOwnership?.();
      };
      let businessOutcome: 'pending' | 'completed' | 'failed' = 'pending';
      let pendingCompletionBytes: number | undefined;
      let pendingFailureReason: ExportFailureCodeV1 | undefined;
      const persistTerminalAudit = retryableCleanup(async () => {
        if (businessOutcome === 'pending') return;
        const intent =
          businessOutcome === 'completed'
            ? pendingCompletionBytes === undefined
              ? null
              : {
                  actor: admittedAudit.principal.actor,
                  correlationId: admittedAudit.correlationId,
                  format: admittedAudit.format,
                  revisionNumber: admittedAudit.revisionNumber,
                  outcome: 'completed' as const,
                  bytes: pendingCompletionBytes,
                }
            : pendingFailureReason === undefined
              ? null
              : {
                  actor: admittedAudit.principal.actor,
                  correlationId: admittedAudit.correlationId,
                  format: admittedAudit.format,
                  revisionNumber: admittedAudit.revisionNumber,
                  outcome: 'failed' as const,
                  reason: pendingFailureReason,
                };
        if (intent === null) throw new ExportFailureV1('EXPORT_INTERNAL_ERROR');
        await persistKnownTerminalAudit(intent);
      });
      const completeRenderer = retryableCleanup(() => lease.completeResponse());
      const abortRenderer = retryableCleanup(() => lease.abort());
      const runCleanup = async (kind: 'complete' | 'abort'): Promise<void> => {
        const rendererCleanup = kind === 'complete' ? completeRenderer() : abortRenderer();
        const failures = await settleCleanupOperations([
          persistTerminalAudit,
          async () => {
            await rendererCleanup;
            await releaseAdmissionOwnership();
          },
        ]);
        if (failures.length > 0) throw failures[0];
      };
      const completeAudit = async (bytes: number): Promise<void> => {
        if (businessOutcome === 'failed') return;
        assertDeliveryOwnership();
        pendingCompletionBytes ??= bytes;
        if (businessOutcome === 'completed') await persistTerminalAudit();
      };
      const failAudit = async (reason: ExportFailureCodeV1): Promise<void> => {
        if (businessOutcome === 'completed') return persistTerminalAudit();
        if (businessOutcome === 'pending') {
          businessOutcome = 'failed';
          pendingFailureReason = reason;
        }
        await persistTerminalAudit();
      };
      const finish = async (kind: 'complete' | 'abort'): Promise<void> => {
        if (kind === 'complete') {
          if (businessOutcome === 'failed') return runCleanup('abort');
          businessOutcome = 'completed';
          return runCleanup('complete');
        }
        return runCleanup(businessOutcome === 'completed' ? 'complete' : 'abort');
      };
      return Object.freeze({
        ...lease,
        ownershipSignal: admittedOwnershipSignal,
        assertOwnership: assertDeliveryOwnership,
        boardTitle: authorized.boardTitle,
        auditCompleted: completeAudit,
        auditFailed: failAudit,
        completeResponse: () => finish('complete'),
        abort: () => finish('abort'),
      });
    } catch (error) {
      if (authorizationCleanupDetached) throw error;
      const cleanup: Array<() => Promise<void>> = [];
      if (auditContext !== undefined) {
        cleanup.push(() => persistAdmissionFailure(error));
      }
      if (!rendererOwnsRuntime) {
        cleanup.push(() => this.broker.dispose(credentials.sessionId));
        cleanup.push(() => this.sessions.cancel({ ...credentials, nowMs: Date.now() }));
        cleanup.push(reconcileProjectionOwnership);
      }
      await settleCleanupOperations(
        cleanup.map((operation) => () => retryDetachedCleanup(operation)),
      );
      throw error;
    }
  }

  private reserve(principal: ResolvedBoardPrincipalV1, boardId: BoardId): () => void {
    const account =
      principal.kind === 'user' ? principal.userPk.toString() : principal.ownerUserPk.toString();
    const credential =
      principal.kind === 'user'
        ? `user:${principal.sessionPk}`
        : principal.kind === 'account_api_key'
          ? `api-key:${principal.apiKeyPk}`
          : 'forbidden';
    if (
      this.activeAccounts.has(account) ||
      this.activeBoards.has(boardId) ||
      this.activeCredentials.has(credential)
    )
      throw new ExportFailureV1('EXPORT_RATE_LIMITED');
    this.activeAccounts.add(account);
    this.activeBoards.add(boardId);
    this.activeCredentials.add(credential);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.activeAccounts.delete(account);
      this.activeBoards.delete(boardId);
      this.activeCredentials.delete(credential);
    };
  }

  private async board(
    connection: PoolConnection,
    boardId: BoardId,
    ownerUserPk: bigint,
  ): Promise<{ boardPk: bigint; title: string }> {
    const [rows] = await connection.execute<BoardRow[]>(
      `SELECT CAST(board_pk AS CHAR) AS boardPk,
              CAST(owner_user_id AS CHAR) AS ownerUserPk,
              title
       FROM boards
       WHERE public_id = ?
       LIMIT 1 FOR SHARE`,
      [boardId],
    );
    const row = rows[0];
    if (rows.length === 0) throw new ExportFailureV1('EXPORT_NOT_FOUND');
    if (rows.length !== 1 || row === undefined || databasePk(row.ownerUserPk) !== ownerUserPk)
      throw new ExportFailureV1('EXPORT_NOT_FOUND');
    return { boardPk: databasePk(row.boardPk), title: row.title };
  }
}
