import type { PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';

import { BoardPersistenceError } from '../common/errors/board-persistence.error.js';
import { withTransaction } from '../database/transaction.js';
import { ExportAuditServiceV1, type ExportAuditActorV1 } from './export-audit.service.js';
import { EXPORT_FAILURE_DEFINITIONS_V1, type ExportFailureCodeV1 } from './export-errors.js';
import type { ExportFormatV1 } from './export-request.schema.js';

type TerminalOutcomeV1 = 'pending' | 'completed' | 'failed';

export type ExportTerminalAuditReservationV1 = Readonly<{
  actor: ExportAuditActorV1;
  correlationId: string;
  format: ExportFormatV1;
  revisionNumber: number;
}>;

export type ExportTerminalAuditIntentV1 = ExportTerminalAuditReservationV1 &
  (
    | Readonly<{ outcome: 'completed'; bytes: number }>
    | Readonly<{ outcome: 'failed'; reason: ExportFailureCodeV1 }>
  );

interface TerminalIntentRow extends RowDataPacket {
  correlationId: string;
  actorKind: 'user' | 'service';
  actorPublicId: string;
  format: ExportFormatV1;
  revisionNumber: string;
  outcome: TerminalOutcomeV1;
  completedBytes: string | null;
  failureReason: string | null;
  persistedAt: string | null;
}

interface PendingIntentRow extends RowDataPacket {
  correlationId: string;
}

interface AmbiguousIntentCountRow extends RowDataPacket {
  ambiguousCount: string;
}

export type ExportTerminalAuditRecoveryResultV1 = Readonly<{
  persisted: number;
  ambiguous: number;
}>;

const CORRELATION_ID_V1 = /^[A-Za-z0-9_-]{1,64}$/u;

const assertReservation = (input: ExportTerminalAuditReservationV1): void => {
  if (!CORRELATION_ID_V1.test(input.correlationId))
    throw new TypeError('invalid export terminal audit correlation ID');
  if (
    (input.actor.principalKind !== 'user' && input.actor.principalKind !== 'service') ||
    input.actor.principalId.length < 1 ||
    input.actor.principalId.length > 128 ||
    input.actor.grantId !== null ||
    (input.format !== 'pdf' && input.format !== 'pptx') ||
    !Number.isSafeInteger(input.revisionNumber) ||
    input.revisionNumber < 1
  )
    throw new TypeError('invalid export terminal audit intent');
};

const assertIntent = (input: ExportTerminalAuditIntentV1): void => {
  assertReservation(input);
  if (input.outcome === 'completed' && (!Number.isSafeInteger(input.bytes) || input.bytes < 0))
    throw new TypeError('invalid completed export terminal audit intent');
  if (input.outcome === 'failed' && !Object.hasOwn(EXPORT_FAILURE_DEFINITIONS_V1, input.reason))
    throw new TypeError('invalid failed export terminal audit intent');
};

const databaseNumber = (value: string): number => {
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) throw new BoardPersistenceError('row_integrity');
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new BoardPersistenceError('row_integrity');
  return parsed;
};

export class ExportTerminalAuditRepositoryV1 {
  private surfacedAmbiguousCount = 0;

  constructor(private readonly audit: ExportAuditServiceV1) {}

  async reserve(
    connection: PoolConnection,
    input: ExportTerminalAuditReservationV1,
  ): Promise<TerminalOutcomeV1> {
    assertReservation(input);
    const [inserted] = await connection.execute<ResultSetHeader>(
      `
      INSERT INTO export_terminal_audit_intents (
        correlation_id, actor_kind, actor_public_id, format, revision_number,
        outcome, completed_bytes, failure_reason, persisted_at, created_at
      ) VALUES (?, ?, ?, ?, ?, 'pending', NULL, NULL, NULL, CURRENT_TIMESTAMP(3))
      ON DUPLICATE KEY UPDATE correlation_id = VALUES(correlation_id)
    `,
      [
        input.correlationId,
        input.actor.principalKind,
        input.actor.principalId,
        input.format,
        input.revisionNumber,
      ],
    );
    if (inserted.affectedRows < 0 || inserted.affectedRows > 2)
      throw new BoardPersistenceError('row_integrity');
    const row = await this.load(connection, input.correlationId, false);
    if (
      row.actorKind !== input.actor.principalKind ||
      row.actorPublicId !== input.actor.principalId ||
      row.format !== input.format ||
      databaseNumber(row.revisionNumber) !== input.revisionNumber
    )
      throw new BoardPersistenceError('row_integrity');
    return row.outcome;
  }

  async finalize(
    connection: PoolConnection,
    input: ExportTerminalAuditIntentV1,
  ): Promise<Exclude<TerminalOutcomeV1, 'pending'>> {
    assertIntent(input);
    const completedBytes = input.outcome === 'completed' ? input.bytes : null;
    const failureReason = input.outcome === 'failed' ? input.reason : null;
    const [updated] = await connection.execute<ResultSetHeader>(
      `
      UPDATE export_terminal_audit_intents
      SET outcome = ?, completed_bytes = ?, failure_reason = ?
      WHERE correlation_id = ?
        AND actor_kind = ?
        AND actor_public_id = ?
        AND format = ?
        AND revision_number = ?
        AND outcome = 'pending'
        AND completed_bytes IS NULL
        AND failure_reason IS NULL
        AND persisted_at IS NULL
    `,
      [
        input.outcome,
        completedBytes,
        failureReason,
        input.correlationId,
        input.actor.principalKind,
        input.actor.principalId,
        input.format,
        input.revisionNumber,
      ],
    );
    if (updated.affectedRows < 0 || updated.affectedRows > 1)
      throw new BoardPersistenceError('row_integrity');
    const row = await this.load(connection, input.correlationId, false);
    if (
      row.actorKind !== input.actor.principalKind ||
      row.actorPublicId !== input.actor.principalId ||
      row.format !== input.format ||
      databaseNumber(row.revisionNumber) !== input.revisionNumber ||
      row.outcome !== input.outcome ||
      (input.outcome === 'completed'
        ? row.completedBytes === null ||
          databaseNumber(row.completedBytes) !== input.bytes ||
          row.failureReason !== null
        : row.completedBytes !== null || row.failureReason !== input.reason)
    )
      throw new BoardPersistenceError('row_integrity');
    return row.outcome;
  }

  async persist(connection: PoolConnection, correlationId: string): Promise<boolean> {
    if (!CORRELATION_ID_V1.test(correlationId))
      throw new TypeError('invalid export terminal audit correlation ID');
    return withTransaction(connection, 'READ COMMITTED', async () => {
      const row = await this.load(connection, correlationId, true);
      if (row.persistedAt !== null) return false;
      if (row.outcome === 'pending') throw new BoardPersistenceError('row_integrity');
      const base = {
        actor: {
          principalKind: row.actorKind,
          principalId: row.actorPublicId,
          grantId: null,
        },
        correlationId: row.correlationId,
        format: row.format,
        revisionNumber: databaseNumber(row.revisionNumber),
      } as const;
      if (row.outcome === 'completed') {
        if (row.completedBytes === null || row.failureReason !== null)
          throw new BoardPersistenceError('row_integrity');
        await this.audit.completedFromIntent(connection, {
          ...base,
          bytes: databaseNumber(row.completedBytes),
        });
      } else {
        if (
          row.completedBytes !== null ||
          row.failureReason === null ||
          !Object.hasOwn(EXPORT_FAILURE_DEFINITIONS_V1, row.failureReason)
        )
          throw new BoardPersistenceError('row_integrity');
        await this.audit.failedFromIntent(connection, {
          ...base,
          reason: row.failureReason as ExportFailureCodeV1,
        });
      }
      const [updated] = await connection.execute<ResultSetHeader>(
        `
        UPDATE export_terminal_audit_intents
        SET persisted_at = CURRENT_TIMESTAMP(3)
        WHERE correlation_id = ? AND persisted_at IS NULL
      `,
        [correlationId],
      );
      if (updated.affectedRows !== 1) throw new BoardPersistenceError('row_integrity');
      return true;
    });
  }

  async recover(connection: PoolConnection): Promise<ExportTerminalAuditRecoveryResultV1> {
    const [rows] = await connection.execute<PendingIntentRow[]>(
      `
      SELECT correlation_id AS correlationId
      FROM export_terminal_audit_intents
      WHERE outcome IN ('completed', 'failed')
        AND persisted_at IS NULL
      ORDER BY terminal_audit_intent_pk ASC
      LIMIT 100
    `,
    );
    let persisted = 0;
    for (const row of rows) {
      if (!CORRELATION_ID_V1.test(row.correlationId)) continue;
      try {
        if (await this.persist(connection, row.correlationId)) persisted += 1;
      } catch {
        // A transient or corrupt intent must not block recovery of later independent rows.
      }
    }
    const [ambiguousRows] = await connection.execute<AmbiguousIntentCountRow[]>(
      `
      SELECT CAST(COUNT(*) AS CHAR) AS ambiguousCount
      FROM export_terminal_audit_intents
      WHERE outcome = 'pending' AND persisted_at IS NULL
    `,
    );
    const ambiguousRow = ambiguousRows[0];
    if (ambiguousRows.length !== 1 || ambiguousRow === undefined)
      throw new BoardPersistenceError('row_integrity');
    const ambiguous = databaseNumber(ambiguousRow.ambiguousCount);
    if (ambiguous > 0 && ambiguous !== this.surfacedAmbiguousCount) {
      process.emitWarning(
        `${ambiguous} export terminal audit intent(s) require operational recovery`,
        { code: 'SCENEBOARD_EXPORT_TERMINAL_AUDIT_AMBIGUOUS' },
      );
    }
    this.surfacedAmbiguousCount = ambiguous;
    return { persisted, ambiguous };
  }

  private async load(
    connection: PoolConnection,
    correlationId: string,
    lock: boolean,
  ): Promise<TerminalIntentRow> {
    const [rows] = await connection.execute<TerminalIntentRow[]>(
      `
      SELECT correlation_id AS correlationId, actor_kind AS actorKind,
             actor_public_id AS actorPublicId, format,
             CAST(revision_number AS CHAR) AS revisionNumber, outcome,
             CAST(completed_bytes AS CHAR) AS completedBytes,
             failure_reason AS failureReason, persisted_at AS persistedAt
      FROM export_terminal_audit_intents
      WHERE correlation_id = ?
      ${lock ? 'FOR UPDATE' : ''}
    `,
      [correlationId],
    );
    const row = rows[0];
    if (rows.length !== 1 || row === undefined) throw new BoardPersistenceError('row_integrity');
    return row;
  }
}
