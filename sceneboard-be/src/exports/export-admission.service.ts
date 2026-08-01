import type { BoardId, RevisionId } from '@sceneboard/board-schema';
import type { PoolConnection, RowDataPacket } from 'mysql2/promise';

import type { MysqlService } from '../database/mysql.service.js';
import type { ResolvedBoardPrincipalV1 } from '../grants/board-access.policy.js';
import { ExportAuditServiceV1 } from './export-audit.service.js';
import { ExportAuthorizationPolicyV1 } from './export-authorization.policy.js';
import { ExportFailureV1, type ExportFailureCodeV1 } from './export-errors.js';
import { ExportGlobalAdmissionRepositoryV1 } from './export-global-admission.repository.js';
import { ExportProjectionServiceV1 } from './export-projection.service.js';
import { ExportRenderBrokerServiceV1 } from './export-render-broker.service.js';
import type { ExportRenderLeaseV1 } from './export-renderer.service.js';
import { ExportRendererServiceV1 } from './export-renderer.service.js';
import { ExportRenderSessionRepositoryV1 } from './export-render-session.repository.js';
import { ExportRevisionHoldRepositoryV1 } from './export-revision-hold.repository.js';
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
    private readonly mysql: MysqlService,
    private readonly origins: ExportRuntimeOriginsV1,
  ) {}

  async admit(input: {
    principal: ResolvedBoardPrincipalV1;
    boardId: BoardId;
    request: unknown;
    correlationId: string;
  }): Promise<ExportAdmittedLeaseV1> {
    const parsed = ExportRequestSchemaV1.safeParse(input.request);
    if (!parsed.success) throw new ExportFailureV1('EXPORT_INVALID_REQUEST');
    const credentials = this.sessions.issueCredentials();
    let releaseReservation: (() => void) | undefined;
    let bundle: Awaited<ReturnType<ExportProjectionServiceV1['project']>> | undefined;
    let globallyAdmitted = false;
    let auditContext:
      | {
          principal: ResolvedBoardPrincipalV1;
          correlationId: string;
          format: ExportFormatV1;
          revisionNumber: number;
        }
      | undefined;
    try {
      const authorized = await this.authorization.authorize({
        principal: input.principal,
        boardId: input.boardId,
        apply: async (connection, context) => {
          releaseReservation?.();
          releaseReservation = undefined;
          bundle = undefined;
          auditContext = undefined;
          releaseReservation = this.reserve(input.principal, input.boardId);
          try {
            const board = await this.board(connection, input.boardId, context.ownerUserPk);
            const projected = await this.projections.project(connection, {
              boardPk: board.boardPk,
              boardId: input.boardId,
              revisionId: parsed.data.revisionId as RevisionId | null,
              sessionId: credentials.sessionId,
            });
            bundle = projected;
            auditContext = {
              principal: input.principal,
              correlationId: input.correlationId,
              format: parsed.data.format,
              revisionNumber: projected.projection.revisionNumber,
            };
            await this.audit.started(connection, auditContext);
            return {
              bundle: projected,
              boardTitle: board.title,
            };
          } catch (error) {
            releaseReservation?.();
            releaseReservation = undefined;
            throw error;
          }
        },
      });
      const admittedBundle = authorized.bundle;
      bundle = admittedBundle;
      globallyAdmitted = await this.globalAdmission.acquire(credentials.sessionId, Date.now());
      if (!globallyAdmitted) throw new ExportFailureV1('EXPORT_RATE_LIMITED');
      await this.sessions.open({
        ...credentials,
        boardPk: admittedBundle.hold.boardPk,
        revisionPk: admittedBundle.hold.revisionPk,
        projectionSha256: admittedBundle.projectionSha256,
        apiOrigin: this.origins.apiOrigin,
        webOrigin: this.origins.webOrigin,
        openedAtMs: Date.now(),
      });
      this.broker.register({
        sessionId: credentials.sessionId,
        bundle: admittedBundle,
        webOrigin: this.origins.webOrigin,
      });
      const lease = await this.renderer.render({
        credentials,
        bundle: admittedBundle,
        apiOrigin: this.origins.apiOrigin,
        webOrigin: this.origins.webOrigin,
        artifactRuntimeOrigin: this.origins.artifactRuntimeOrigin,
        renewHold: () =>
          this.mysql.withConnection((renewConnection) =>
            this.holds.renew(renewConnection, admittedBundle.hold),
          ),
        releaseHold: () =>
          this.mysql.withConnection((releaseConnection) =>
            this.holds.release(releaseConnection, admittedBundle.hold).then(() => undefined),
          ),
      });
      const admittedAudit = auditContext;
      if (admittedAudit === undefined) throw new ExportFailureV1('EXPORT_INTERNAL_ERROR');
      let responseTerminal = false;
      let auditTerminalPromise: Promise<void> | undefined;
      let pendingCompletionBytes: number | undefined;
      const claimAuditTerminal = (write: () => Promise<void>): Promise<void> => {
        if (auditTerminalPromise !== undefined) return auditTerminalPromise;
        auditTerminalPromise = Promise.resolve().then(write);
        return auditTerminalPromise;
      };
      const finish = async (kind: 'complete' | 'abort'): Promise<void> => {
        if (responseTerminal) return;
        responseTerminal = true;
        try {
          if (kind === 'complete') {
            await lease.completeResponse();
            if (pendingCompletionBytes !== undefined) {
              const bytes = pendingCompletionBytes;
              await claimAuditTerminal(() =>
                this.mysql.withConnection((connection) =>
                  this.audit.completed(connection, { ...admittedAudit, bytes }),
                ),
              );
            }
          } else await lease.abort();
        } finally {
          if (globallyAdmitted) {
            await this.globalAdmission.release(credentials.sessionId).catch(() => undefined);
            globallyAdmitted = false;
          }
          releaseReservation?.();
          releaseReservation = undefined;
        }
      };
      const completeAudit = async (bytes: number): Promise<void> => {
        if (auditTerminalPromise !== undefined) return auditTerminalPromise;
        if (pendingCompletionBytes === undefined) pendingCompletionBytes = bytes;
      };
      const failAudit = (reason: ExportFailureCodeV1): Promise<void> =>
        claimAuditTerminal(() =>
          this.mysql.withConnection((connection) =>
            this.audit.failed(connection, { ...admittedAudit, reason }),
          ),
        );
      return Object.freeze({
        ...lease,
        boardTitle: authorized.boardTitle,
        auditCompleted: completeAudit,
        auditFailed: failAudit,
        completeResponse: () => finish('complete'),
        abort: () => finish('abort'),
      });
    } catch (error) {
      let auditError: unknown;
      if (auditContext !== undefined) {
        const reason = error instanceof ExportFailureV1 ? error.code : 'EXPORT_INTERNAL_ERROR';
        try {
          await this.mysql.withConnection((connection) =>
            this.audit.failed(connection, { ...auditContext!, reason }),
          );
        } catch (failedAuditError) {
          auditError = failedAuditError;
        }
      }
      await this.broker.dispose(credentials.sessionId).catch(() => undefined);
      await this.sessions.cancel({ ...credentials, nowMs: Date.now() }).catch(() => undefined);
      const failedBundle = bundle;
      if (failedBundle !== undefined)
        await this.mysql
          .withConnection((connection) =>
            this.holds.release(connection, failedBundle.hold).then(() => undefined),
          )
          .catch(() => undefined);
      if (globallyAdmitted) {
        await this.globalAdmission.release(credentials.sessionId).catch(() => undefined);
        globallyAdmitted = false;
      }
      releaseReservation?.();
      if (auditError !== undefined) throw new ExportFailureV1('EXPORT_INTERNAL_ERROR', auditError);
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
