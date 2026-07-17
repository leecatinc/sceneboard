import type { PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';

import { AuditRepository } from '../audit/audit.repository.js';
import { MysqlService } from '../database/mysql.service.js';
import { isMysqlLockAcquired } from '../common/database/mysql-lock.js';
import { withTransaction } from '../database/transaction.js';

export type SecurityRetentionMode = 'status' | 'dry-run' | 'run';

interface RetentionTarget {
  name: string;
  indexName: string;
  oldestColumn: string;
  batchLimit: 500;
  selectSql: string;
  cutoff(now: number): Date;
  mutation: 'pairing-expire' | 'grant-expire' | 'delete-pairing' | 'delete-grant'
    | 'delete-credential' | 'delete-session' | 'delete-audit';
}

const daysBefore = (now: number, days: number): Date => new Date(now - days * 24 * 60 * 60 * 1_000);
const atNow = (now: number): Date => new Date(now);

export const SECURITY_RETENTION_TARGETS: readonly RetentionTarget[] = [
  {
    name: 'pairing-created-expiry', indexName: 'ix_pairing_state_code_expiry', oldestColumn: 'code_expires_at', batchLimit: 500,
    selectSql: 'SELECT CAST(id AS CHAR) AS id FROM pairing_requests FORCE INDEX (ix_pairing_state_code_expiry) WHERE state = 1 AND code_expires_at <= ? ORDER BY code_expires_at, id LIMIT ?',
    cutoff: atNow, mutation: 'pairing-expire',
  },
  {
    name: 'pairing-pending-expiry', indexName: 'ix_pairing_state_decision_expiry', oldestColumn: 'decision_expires_at', batchLimit: 500,
    selectSql: 'SELECT CAST(id AS CHAR) AS id FROM pairing_requests FORCE INDEX (ix_pairing_state_decision_expiry) WHERE state = 2 AND decision_expires_at <= ? ORDER BY decision_expires_at, id LIMIT ?',
    cutoff: atNow, mutation: 'pairing-expire',
  },
  {
    name: 'pairing-approved-expiry', indexName: 'ix_pairing_state_redeem_expiry', oldestColumn: 'redeem_expires_at', batchLimit: 500,
    selectSql: 'SELECT CAST(id AS CHAR) AS id FROM pairing_requests FORCE INDEX (ix_pairing_state_redeem_expiry) WHERE state = 3 AND redeem_expires_at <= ? ORDER BY redeem_expires_at, id LIMIT ?',
    cutoff: atNow, mutation: 'pairing-expire',
  },
  {
    name: 'pairing-terminal-delete', indexName: 'ix_pairing_state_updated', oldestColumn: 'updated_at', batchLimit: 500,
    selectSql: 'SELECT CAST(id AS CHAR) AS id FROM pairing_requests FORCE INDEX (ix_pairing_state_updated) WHERE state IN (4,5,6,7,8) AND updated_at <= ? ORDER BY state, updated_at, id LIMIT ?',
    cutoff: (now) => daysBefore(now, 30), mutation: 'delete-pairing',
  },
  {
    name: 'grant-active-expiry', indexName: 'ix_grants_status_expiry', oldestColumn: 'expires_at', batchLimit: 500,
    selectSql: 'SELECT CAST(id AS CHAR) AS id FROM mcp_grants FORCE INDEX (ix_grants_status_expiry) WHERE status = 2 AND expires_at <= ? ORDER BY status, expires_at, id LIMIT ?',
    cutoff: atNow, mutation: 'grant-expire',
  },
  {
    name: 'credential-rotated-delete', indexName: 'ix_grant_credentials_status_revoked', oldestColumn: 'revoked_at', batchLimit: 500,
    selectSql: 'SELECT CAST(id AS CHAR) AS id FROM mcp_grant_credentials FORCE INDEX (ix_grant_credentials_status_revoked) WHERE status = 2 AND revoked_at <= ? ORDER BY status, revoked_at, id LIMIT ?',
    cutoff: (now) => daysBefore(now, 365), mutation: 'delete-credential',
  },
  {
    name: 'credential-revoked-delete', indexName: 'ix_grant_credentials_status_revoked', oldestColumn: 'revoked_at', batchLimit: 500,
    selectSql: 'SELECT CAST(id AS CHAR) AS id FROM mcp_grant_credentials FORCE INDEX (ix_grant_credentials_status_revoked) WHERE status = 3 AND revoked_at <= ? ORDER BY status, revoked_at, id LIMIT ?',
    cutoff: (now) => daysBefore(now, 365), mutation: 'delete-credential',
  },
  {
    name: 'grant-revoked-delete', indexName: 'ix_grants_status_revoked', oldestColumn: 'revoked_at', batchLimit: 500,
    selectSql: 'SELECT CAST(id AS CHAR) AS id FROM mcp_grants FORCE INDEX (ix_grants_status_revoked) WHERE status = 3 AND revoked_at <= ? ORDER BY status, revoked_at, id LIMIT ?',
    cutoff: (now) => daysBefore(now, 365), mutation: 'delete-grant',
  },
  {
    name: 'grant-expired-delete', indexName: 'ix_grants_status_expiry', oldestColumn: 'expires_at', batchLimit: 500,
    selectSql: 'SELECT CAST(id AS CHAR) AS id FROM mcp_grants FORCE INDEX (ix_grants_status_expiry) WHERE status = 4 AND expires_at <= ? ORDER BY status, expires_at, id LIMIT ?',
    cutoff: (now) => daysBefore(now, 365), mutation: 'delete-grant',
  },
  {
    name: 'session-expired-delete', indexName: 'ix_sessions_status_absolute', oldestColumn: 'absolute_expires_at', batchLimit: 500,
    selectSql: `SELECT CAST(s.id AS CHAR) AS id FROM auth_sessions s FORCE INDEX (ix_sessions_status_absolute)
      WHERE s.status = 4 AND s.absolute_expires_at <= ?
        AND NOT EXISTS (SELECT 1 FROM mcp_grants g WHERE g.source_session_id = s.id)
        AND NOT EXISTS (SELECT 1 FROM pairing_requests p WHERE p.source_session_id = s.id)
        AND NOT EXISTS (SELECT 1 FROM security_audit_events a WHERE a.session_public_id = s.public_id)
      ORDER BY s.status, s.absolute_expires_at, s.id LIMIT ?`,
    cutoff: (now) => daysBefore(now, 180), mutation: 'delete-session',
  },
  {
    name: 'session-revoked-delete', indexName: 'ix_sessions_status_revoked', oldestColumn: 'revoked_at', batchLimit: 500,
    selectSql: `SELECT CAST(s.id AS CHAR) AS id FROM auth_sessions s FORCE INDEX (ix_sessions_status_revoked)
      WHERE s.status = 3 AND s.revoked_at <= ?
        AND NOT EXISTS (SELECT 1 FROM mcp_grants g WHERE g.source_session_id = s.id)
        AND NOT EXISTS (SELECT 1 FROM pairing_requests p WHERE p.source_session_id = s.id)
        AND NOT EXISTS (SELECT 1 FROM security_audit_events a WHERE a.session_public_id = s.public_id)
      ORDER BY s.status, s.revoked_at, s.id LIMIT ?`,
    cutoff: (now) => daysBefore(now, 180), mutation: 'delete-session',
  },
  {
    name: 'session-rotated-delete', indexName: 'ix_sessions_status_rotated', oldestColumn: 'rotated_at', batchLimit: 500,
    selectSql: `SELECT CAST(s.id AS CHAR) AS id FROM auth_sessions s FORCE INDEX (ix_sessions_status_rotated)
      WHERE s.status = 2 AND s.rotated_at <= ?
        AND NOT EXISTS (SELECT 1 FROM mcp_grants g WHERE g.source_session_id = s.id)
        AND NOT EXISTS (SELECT 1 FROM pairing_requests p WHERE p.source_session_id = s.id)
        AND NOT EXISTS (SELECT 1 FROM security_audit_events a WHERE a.session_public_id = s.public_id)
      ORDER BY s.status, s.rotated_at, s.id LIMIT ?`,
    cutoff: (now) => daysBefore(now, 180), mutation: 'delete-session',
  },
  {
    name: 'security-audit-delete', indexName: 'ix_audit_occurred', oldestColumn: 'occurred_at', batchLimit: 500,
    selectSql: 'SELECT CAST(id AS CHAR) AS id FROM security_audit_events FORCE INDEX (ix_audit_occurred) WHERE occurred_at <= ? ORDER BY occurred_at, id LIMIT ?',
    cutoff: (now) => daysBefore(now, 365), mutation: 'delete-audit',
  },
] as const;

interface IdRow extends RowDataPacket { id: string }
interface LockRow extends RowDataPacket { acquired: number | string | null }
interface StatusRow extends RowDataPacket { dueCount: number | string; oldestDueAt: Date | string | null }

export interface SecurityRetentionReport {
  mode: SecurityRetentionMode;
  outcome: 'success' | 'overlap';
  selectedRows: number;
  mutatedRows: number;
  durationMs: number;
  capped: boolean;
  targets: Record<string, number>;
  oldestDueAt: Record<string, string | null>;
}

const MAX_ROWS = 10_000;
const MAX_DURATION_MS = 15 * 60 * 1_000;

export class SecurityRetentionService {
  constructor(
    private readonly mysql: MysqlService,
    private readonly audit: AuditRepository,
  ) {}

  async execute(mode: SecurityRetentionMode, now: number = Date.now()): Promise<SecurityRetentionReport> {
    if (!Number.isSafeInteger(now)) throw new TypeError('retention clock is invalid');
    const startedAt = performance.now();
    if (mode === 'status') return this.mysql.withConnection(async (connection) => {
      const report = this.emptyReport(mode, startedAt);
      for (const target of SECURITY_RETENTION_TARGETS) {
        const [rows] = await connection.execute<StatusRow[]>(statusSqlFor(target), [target.cutoff(now)]);
        const dueCount = Number(rows[0]?.dueCount ?? 0);
        if (!Number.isSafeInteger(dueCount) || dueCount < 0) throw new TypeError('retention due count is invalid');
        const oldestDueAt = rows[0]?.oldestDueAt ?? null;
        report.targets[target.name] = dueCount;
        report.oldestDueAt[target.name] = formatUtcDate(oldestDueAt);
        report.selectedRows += dueCount;
      }
      report.durationMs = elapsed(startedAt);
      return report;
    });

    return this.mysql.withConnection(async (connection) => {
      const [lockRows] = await connection.query<LockRow[]>(
        "SELECT GET_LOCK('leecat-board:security-retention:v1', 0) AS acquired",
      );
      if (!isMysqlLockAcquired(lockRows[0]?.acquired)) {
        return { ...this.emptyReport(mode, startedAt), outcome: 'overlap', durationMs: elapsed(startedAt) };
      }
      try {
        const report = this.emptyReport(mode, startedAt);
        for (const target of SECURITY_RETENTION_TARGETS) {
          while (report.selectedRows < MAX_ROWS && elapsed(startedAt) < MAX_DURATION_MS) {
            const remaining = Math.min(target.batchLimit, MAX_ROWS - report.selectedRows);
            const selectSql = target.selectSql.replace(/LIMIT \?$/u, `LIMIT ${remaining}`);
            const [rows] = await connection.execute<IdRow[]>(selectSql, [target.cutoff(now)]);
            report.targets[target.name] = (report.targets[target.name] ?? 0) + rows.length;
            report.selectedRows += rows.length;
            if (rows.length === 0 || mode === 'dry-run') break;
            report.mutatedRows += await withTransaction(connection, 'READ COMMITTED', (transaction) => (
              this.mutateBatch(transaction, target, rows.map((row) => row.id), target.cutoff(now), now)
            ));
            if (rows.length < remaining) break;
          }
          if (report.selectedRows >= MAX_ROWS || elapsed(startedAt) >= MAX_DURATION_MS) break;
        }
        report.capped = report.selectedRows >= MAX_ROWS || elapsed(startedAt) >= MAX_DURATION_MS;
        if (mode === 'run') {
          await withTransaction(connection, 'READ COMMITTED', async () => {
            await this.audit.writeMandatory({ connection }, {
              event: 'security_retention_run',
              userPublicId: null,
              sessionPublicId: null,
              subjectFingerprint: null,
              metadata: { mode, outcome: 'success', rows: report.mutatedRows },
            });
          });
        }
        report.durationMs = elapsed(startedAt);
        return report;
      } finally {
        await connection.query("SELECT RELEASE_LOCK('leecat-board:security-retention:v1')");
      }
    });
  }

  private emptyReport(mode: SecurityRetentionMode, startedAt: number): SecurityRetentionReport {
    return {
      mode,
      outcome: 'success',
      selectedRows: 0,
      mutatedRows: 0,
      durationMs: elapsed(startedAt),
      capped: false,
      targets: Object.create(null) as Record<string, number>,
      oldestDueAt: Object.create(null) as Record<string, string | null>,
    };
  }

  private async mutateBatch(
    connection: PoolConnection,
    target: RetentionTarget,
    ids: string[],
    cutoff: Date,
    now: number,
  ): Promise<number> {
    if (target.mutation === 'pairing-expire') {
      let mutated = 0;
      for (const id of ids) mutated += await this.expirePairing(connection, id, now);
      return mutated;
    }
    if (target.mutation === 'grant-expire') {
      let mutated = 0;
      for (const id of ids) mutated += await this.expireGrant(connection, id, now);
      return mutated;
    }
    const placeholders = ids.map(() => '?').join(', ');
    const { statement, state } = deleteStatementFor(target, placeholders);
    const parameters = state === null ? [...ids, cutoff] : [...ids, state, cutoff];
    const [result] = await connection.execute<ResultSetHeader>(statement, parameters);
    return result.affectedRows;
  }

  private async expirePairing(connection: PoolConnection, id: string, now: number): Promise<number> {
    const [familyLinks] = await connection.execute<Array<RowDataPacket & { familyPublicId: string }>>(`
      SELECT s.family_public_id AS familyPublicId
      FROM pairing_requests p JOIN auth_sessions s ON s.id = p.source_session_id
      WHERE p.id = ?
    `, [id]);
    const family = familyLinks[0]?.familyPublicId;
    if (family === undefined) return 0;
    await connection.execute('SELECT id FROM auth_sessions WHERE family_public_id = ? ORDER BY id FOR UPDATE', [family]);
    const [rows] = await connection.execute<Array<RowDataPacket & {
      id: string; state: number; publicId: string; ownerUserPublicId: string;
      sourceSessionPublicId: string; lockedFamilyPublicId: string; clientPublicId: string | null;
      grantDatabaseId: string | null; due: number;
    }>>(`
      SELECT CAST(p.id AS CHAR) AS id, p.state, p.public_id AS publicId,
        u.public_id AS ownerUserPublicId, s.public_id AS sourceSessionPublicId,
        s.family_public_id AS lockedFamilyPublicId, c.public_id AS clientPublicId,
        CAST(p.grant_id AS CHAR) AS grantDatabaseId,
        CASE WHEN p.state = 1 THEN p.code_expires_at <= ?
             WHEN p.state = 2 THEN p.decision_expires_at <= ?
             WHEN p.state = 3 THEN p.redeem_expires_at <= ? ELSE 0 END AS due
      FROM pairing_requests p
      JOIN users u ON u.id = p.owner_user_id
      JOIN auth_sessions s ON s.id = p.source_session_id
      LEFT JOIN mcp_clients c ON c.id = p.client_id
      WHERE p.id = ? FOR UPDATE
    `, [new Date(now), new Date(now), new Date(now), id]);
    const row = rows[0];
    if (row === undefined || row.lockedFamilyPublicId !== family) return 0;
    if (row.due !== 1 || ![1, 2, 3].includes(row.state)) return 0;
    let grantPublicId: string | null = null;
    if (row.grantDatabaseId !== null) {
      const [grantRows] = await connection.execute<Array<RowDataPacket & { publicId: string; status: number }>>(
        'SELECT public_id AS publicId, status FROM mcp_grants WHERE id = ? FOR UPDATE',
        [row.grantDatabaseId],
      );
      const grant = grantRows[0];
      if (grant === undefined || grant.status !== 1) throw new Error('approved pairing has no pending grant');
      grantPublicId = grant.publicId;
      await connection.execute('SELECT id FROM mcp_grant_credentials WHERE grant_id = ? ORDER BY id FOR UPDATE', [row.grantDatabaseId]);
      await connection.execute('UPDATE mcp_grant_credentials SET status = 3, revoked_at = ? WHERE grant_id = ? AND status = 1', [new Date(now), row.grantDatabaseId]);
      const [grantUpdated] = await connection.execute<ResultSetHeader>('UPDATE mcp_grants SET status = 4, revoked_at = ?, revoke_reason = 3, updated_at = ? WHERE id = ? AND status = 1', [new Date(now), new Date(now), row.grantDatabaseId]);
      if (grantUpdated.affectedRows !== 1) throw new Error('pending grant expiry lost its compare-and-set');
      await this.audit.writeMandatory({ connection }, {
        event: 'grant_expire', userPublicId: row.ownerUserPublicId,
        sessionPublicId: row.sourceSessionPublicId, clientPublicId: row.clientPublicId,
        grantPublicId, pairingPublicId: row.publicId,
        subjectFingerprint: null, metadata: { reason: 'deadline' },
      });
    }
    const deadlineColumn = row.state === 1 ? 'code_expires_at' : row.state === 2 ? 'decision_expires_at' : 'redeem_expires_at';
    const [updated] = await connection.execute<ResultSetHeader>(
      `UPDATE pairing_requests SET state = 7, code_locator_hash = NULL, code_verifier_hash = NULL, updated_at = ?
       WHERE id = ? AND state = ? AND ${deadlineColumn} <= ?`,
      [new Date(now), id, row.state, new Date(now)],
    );
    if (updated.affectedRows !== 1) throw new Error('pairing expiry lost its compare-and-set');
    await this.audit.writeMandatory({ connection }, {
      event: 'pairing_expire', userPublicId: row.ownerUserPublicId,
      sessionPublicId: row.sourceSessionPublicId, clientPublicId: row.clientPublicId,
      grantPublicId, pairingPublicId: row.publicId,
      subjectFingerprint: null, metadata: { reason: 'deadline' },
    });
    return 1;
  }

  private async expireGrant(connection: PoolConnection, id: string, now: number): Promise<number> {
    const [familyLinks] = await connection.execute<Array<RowDataPacket & { familyPublicId: string | null }>>(`
      SELECT s.family_public_id AS familyPublicId
      FROM mcp_grants g LEFT JOIN auth_sessions s ON s.id = g.source_session_id
      WHERE g.id = ?
    `, [id]);
    const family = familyLinks[0]?.familyPublicId;
    if (family !== undefined && family !== null) {
      await connection.execute('SELECT id FROM auth_sessions WHERE family_public_id = ? ORDER BY id FOR UPDATE', [family]);
    }
    const [rows] = await connection.execute<Array<RowDataPacket & {
      publicId: string; ownerUserPublicId: string; clientPublicId: string;
      sourceSessionPublicId: string | null; sourceFamilyPublicId: string | null; due: number;
    }>>(`
      SELECT g.public_id AS publicId, u.public_id AS ownerUserPublicId,
        c.public_id AS clientPublicId, s.public_id AS sourceSessionPublicId,
        s.family_public_id AS sourceFamilyPublicId, g.expires_at <= ? AS due
      FROM mcp_grants g JOIN users u ON u.id = g.owner_user_id
      JOIN mcp_clients c ON c.id = g.client_id
      LEFT JOIN auth_sessions s ON s.id = g.source_session_id
      WHERE g.id = ? AND g.status = 2 FOR UPDATE
    `, [new Date(now), id]);
    const row = rows[0];
    if (row === undefined || row.sourceFamilyPublicId !== (family ?? null) || row.due !== 1) return 0;
    await connection.execute('SELECT id FROM mcp_grant_credentials WHERE grant_id = ? ORDER BY id FOR UPDATE', [id]);
    await connection.execute('UPDATE mcp_grant_credentials SET status = 3, revoked_at = ? WHERE grant_id = ? AND status = 1', [new Date(now), id]);
    const [updated] = await connection.execute<ResultSetHeader>('UPDATE mcp_grants SET status = 4, revoked_at = ?, revoke_reason = 3, updated_at = ? WHERE id = ? AND status = 2', [new Date(now), new Date(now), id]);
    if (updated.affectedRows !== 1) return 0;
    await this.audit.writeMandatory({ connection }, {
      event: 'grant_expire', userPublicId: row.ownerUserPublicId,
      sessionPublicId: row.sourceSessionPublicId, clientPublicId: row.clientPublicId,
      grantPublicId: row.publicId, subjectFingerprint: null,
      metadata: { reason: 'deadline' },
    });
    return 1;
  }
}

const elapsed = (startedAt: number): number => Math.max(0, Math.ceil(performance.now() - startedAt));

const formatUtcDate = (value: Date | string | null): string | null => {
  if (value === null) return null;
  if (value instanceof Date) return value.toISOString();
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{3})?$/.test(value)) {
    throw new TypeError('retention oldest timestamp is invalid');
  }
  return `${value.replace(' ', 'T')}${value.includes('.') ? '' : '.000'}Z`;
};

const statusSqlFor = (target: RetentionTarget): string => {
  const from = target.selectSql.indexOf(' FROM ');
  const order = target.selectSql.lastIndexOf(' ORDER BY ');
  if (from < 0 || order <= from) throw new TypeError(`invalid retention selector: ${target.name}`);
  return `SELECT COUNT(*) AS dueCount, MIN(${target.oldestColumn}) AS oldestDueAt${target.selectSql.slice(from, order)}`;
};

const deleteStatementFor = (
  target: RetentionTarget,
  placeholders: string,
): { statement: string; state: number | null } => {
  switch (target.name) {
    case 'pairing-terminal-delete':
      return {
        statement: `DELETE FROM pairing_requests WHERE id IN (${placeholders}) AND state IN (4,5,6,7,8) AND updated_at <= ?`,
        state: null,
      };
    case 'credential-rotated-delete':
      return { statement: `DELETE FROM mcp_grant_credentials WHERE id IN (${placeholders}) AND status = ? AND revoked_at <= ?`, state: 2 };
    case 'credential-revoked-delete':
      return { statement: `DELETE FROM mcp_grant_credentials WHERE id IN (${placeholders}) AND status = ? AND revoked_at <= ?`, state: 3 };
    case 'grant-revoked-delete':
      return { statement: `DELETE FROM mcp_grants WHERE id IN (${placeholders}) AND status = ? AND revoked_at <= ?`, state: 3 };
    case 'grant-expired-delete':
      return { statement: `DELETE FROM mcp_grants WHERE id IN (${placeholders}) AND status = ? AND expires_at <= ?`, state: 4 };
    case 'session-expired-delete':
      return {
        statement: `DELETE s FROM auth_sessions s WHERE s.id IN (${placeholders}) AND s.status = ? AND s.absolute_expires_at <= ?
          AND NOT EXISTS (SELECT 1 FROM mcp_grants g WHERE g.source_session_id = s.id)
          AND NOT EXISTS (SELECT 1 FROM pairing_requests p WHERE p.source_session_id = s.id)
          AND NOT EXISTS (SELECT 1 FROM security_audit_events a WHERE a.session_public_id = s.public_id)`,
        state: 4,
      };
    case 'session-revoked-delete':
      return {
        statement: `DELETE s FROM auth_sessions s WHERE s.id IN (${placeholders}) AND s.status = ? AND s.revoked_at <= ?
          AND NOT EXISTS (SELECT 1 FROM mcp_grants g WHERE g.source_session_id = s.id)
          AND NOT EXISTS (SELECT 1 FROM pairing_requests p WHERE p.source_session_id = s.id)
          AND NOT EXISTS (SELECT 1 FROM security_audit_events a WHERE a.session_public_id = s.public_id)`,
        state: 3,
      };
    case 'session-rotated-delete':
      return {
        statement: `DELETE s FROM auth_sessions s WHERE s.id IN (${placeholders}) AND s.status = ? AND s.rotated_at <= ?
          AND NOT EXISTS (SELECT 1 FROM mcp_grants g WHERE g.source_session_id = s.id)
          AND NOT EXISTS (SELECT 1 FROM pairing_requests p WHERE p.source_session_id = s.id)
          AND NOT EXISTS (SELECT 1 FROM security_audit_events a WHERE a.session_public_id = s.public_id)`,
        state: 2,
      };
    case 'security-audit-delete':
      return { statement: `DELETE FROM security_audit_events WHERE id IN (${placeholders}) AND occurred_at <= ?`, state: null };
    default:
      throw new TypeError(`retention target is not deletable: ${target.name}`);
  }
};
