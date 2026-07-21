import { createHash, timingSafeEqual } from 'node:crypto';

import {
  BoardEventEnvelopeParserV1,
  MutationResultParserV1,
  buildMutationFingerprintV1,
  canonicalizeJsonV1,
  type ActorContextV1,
  type BoardEventEnvelopeV1,
  type BoardId,
  type EventId,
  type MutationRequestV1,
  type MutationResultV1,
  type RevisionId,
  type TimestampV1,
} from '@sceneboard/board-schema';
import type { PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';

import { BoardContractError } from '../common/errors/app-error.js';
import { BoardPersistenceError } from '../common/errors/board-persistence.error.js';
import {
  formatPublicUuidV4,
  generatePublicUuidV4,
  parsePublicUuidV4,
} from '../common/ids/public-uuid.storage.js';
import {
  formatMysqlTimestampUtc,
  formatProtocolTimestampUtcForMysql,
} from '../common/time/mysql-timestamp.js';
import type {
  AuthorizedBoardContextV1,
  ResolvedBoardPrincipalV1,
} from '../grants/board-access.policy.js';

export type PreparedControlMutationV1 = {
  eventId: EventId;
  eventIdBytes: Buffer;
  recordIdBytes: Buffer;
  occurredAt: TimestampV1;
  occurredAtSql: string;
  expiresAtSql: string;
  fingerprintPayload: Buffer;
  fingerprintSha256: Buffer;
  actorScopesPayload: Buffer;
  actorScopesSha256: Buffer;
  commandPayloadSha256: Buffer;
  idempotencyScopeSha256: Buffer;
};

export type LockedControlMutationHeadV1 = {
  boardPk: string;
  headRevisionPk: string;
  headRevisionId: RevisionId;
  headRevisionNumber: number;
  lastEventSequence: number;
};

export type ControlMutationAdmissionV1 =
  | { kind: 'new'; recordPk: bigint }
  | { kind: 'replay'; result: MutationResultV1 };

interface IdempotencyRow extends RowDataPacket {
  statusCode: string;
  operationType: string;
  fingerprintSha256: Buffer;
  actorGrantId: string | null;
  actorScopesSha256: Buffer;
  expectedRevisionId: string | null;
  commandPayloadSha256: Buffer;
  resultPayload: Buffer | null;
  resultCanonicalBytes: number | null;
  resultSha256: Buffer | null;
  resultBoardPk: string | null;
  resultRevisionPk: string | null;
}

interface HeadRow extends RowDataPacket {
  boardPk: string;
  archivedAt: string | null;
  headRevisionPk: string;
  headRevisionId: Buffer;
  headRevisionNumber: string;
  lastEventSequence: string;
}

interface ReplayEventRow extends RowDataPacket {
  eventId: Buffer;
  boardPk: string;
}

const DAY_MS = 24 * 60 * 60 * 1_000;
const MAX_SAFE_SEQUENCE = Number.MAX_SAFE_INTEGER;
const digest = (value: Uint8Array): Buffer => createHash('sha256').update(value).digest();
const equalDigest = (left: Uint8Array, right: Uint8Array): boolean =>
  left.byteLength === right.byteLength && timingSafeEqual(Buffer.from(left), Buffer.from(right));

const internalFailure = (): BoardContractError =>
  new BoardContractError({
    protocolVersion: 1,
    type: 'board.error',
    code: 'INTERNAL_ERROR',
    message: 'Internal error',
    category: 'internal',
    retryable: false,
    httpStatusHint: 500,
    details: null,
  });

const canonicalBytes = (value: unknown): Buffer => {
  const parsed = canonicalizeJsonV1(value);
  if (!parsed.ok) throw new BoardContractError(parsed.error);
  return Buffer.from(parsed.data.canonicalBytes);
};

const actorCode = (kind: AuthorizedBoardContextV1['actor']['principalKind']): 'U' | 'M' | 'S' => {
  if (kind === 'user') return 'U';
  if (kind === 'mcp_client') return 'M';
  return 'S';
};

const safeInteger = (value: string, allowZero: boolean): number => {
  const pattern = allowZero ? /^(?:0|[1-9][0-9]{0,15})$/u : /^[1-9][0-9]{0,15}$/u;
  if (!pattern.test(value)) throw new BoardPersistenceError('row_integrity');
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new BoardPersistenceError('row_integrity');
  return parsed;
};

const insertedPk = (result: ResultSetHeader): bigint => {
  if (result.affectedRows !== 1 || !Number.isSafeInteger(result.insertId) || result.insertId < 1) {
    throw internalFailure();
  }
  return BigInt(result.insertId);
};

const revisionConflict = (
  request: Pick<MutationRequestV1, 'boardId' | 'expectedRevisionId'>,
  actualRevisionId: RevisionId,
  actualRevisionNumber: number,
): BoardContractError =>
  new BoardContractError({
    protocolVersion: 1,
    type: 'board.error',
    code: 'REVISION_CONFLICT',
    message: 'Revision conflict',
    category: 'conflict',
    retryable: false,
    httpStatusHint: 409,
    details: {
      boardId: request.boardId,
      expectedRevisionId: request.expectedRevisionId,
      actualRevisionId,
      actualRevisionNumber,
      recovery: 'fetch_latest_then_retry',
    },
  });

const idempotencyReuse = (
  request: MutationRequestV1,
  reason: 'grant_changed' | 'scopes_changed' | 'expected_revision_changed' | 'payload_changed',
): BoardContractError =>
  new BoardContractError({
    protocolVersion: 1,
    type: 'board.error',
    code: 'IDEMPOTENCY_KEY_REUSED',
    message: 'Idempotency key was reused for a different operation',
    category: 'conflict',
    retryable: false,
    httpStatusHint: 409,
    details: {
      scope: 'board.mutation',
      boardId: request.boardId,
      operationType: request.command.type,
      reason,
    },
  });

export const prepareControlMutationV1 = (input: {
  principal: ResolvedBoardPrincipalV1 | { actor: ActorContextV1 };
  request: MutationRequestV1;
  now?: Date;
  generateUuid?: () => string;
}): PreparedControlMutationV1 => {
  const fingerprint = buildMutationFingerprintV1({
    ...input.request,
    actor: input.principal.actor,
  });
  if (!fingerprint.ok) throw new BoardContractError(fingerprint.error);
  const now = input.now ?? new Date();
  if (!Number.isFinite(now.valueOf())) throw internalFailure();
  const generateUuid = input.generateUuid ?? generatePublicUuidV4;
  const eventUuid = generateUuid();
  const recordUuid = generateUuid();
  const expiresAt = new Date(now.valueOf() + 30 * DAY_MS);
  const fingerprintPayload = Buffer.from(fingerprint.data.canonicalBytes);
  const actorScopesPayload = canonicalBytes(input.principal.actor.scopes);
  const commandPayload = canonicalBytes(input.request.command);
  const scopePayload = canonicalBytes({
    scope: 'board.mutation',
    principalKind: input.principal.actor.principalKind,
    principalId: input.principal.actor.principalId,
    boardId: input.request.boardId,
    idempotencyKey: input.request.idempotencyKey,
  });
  return {
    eventId: eventUuid as EventId,
    eventIdBytes: Buffer.from(parsePublicUuidV4(eventUuid)),
    recordIdBytes: Buffer.from(parsePublicUuidV4(recordUuid)),
    occurredAt: now.toISOString() as TimestampV1,
    occurredAtSql: formatMysqlTimestampUtc(now),
    expiresAtSql: formatMysqlTimestampUtc(expiresAt),
    fingerprintPayload,
    fingerprintSha256: digest(fingerprintPayload),
    actorScopesPayload,
    actorScopesSha256: digest(actorScopesPayload),
    commandPayloadSha256: digest(commandPayload),
    idempotencyScopeSha256: digest(scopePayload),
  };
};

export class ControlMutationRepository {
  async begin(
    connection: PoolConnection,
    context: AuthorizedBoardContextV1,
    request: MutationRequestV1,
    prepared: PreparedControlMutationV1,
  ): Promise<ControlMutationAdmissionV1> {
    const [insert] = await connection.execute<ResultSetHeader>(
      `
      INSERT INTO board_idempotency_records (
        record_id, scope_code, principal_kind, principal_id, scope_subject,
        idempotency_key, operation_type, fingerprint_version, fingerprint_payload,
        fingerprint_canonical_bytes, fingerprint_sha256, actor_grant_id,
        actor_scopes_payload, actor_scopes_sha256, expected_revision_id,
        command_payload_sha256, initial_request_id, status_code, created_at
      ) VALUES (?, 'M', ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'P', ?)
      ON DUPLICATE KEY UPDATE record_pk = LAST_INSERT_ID(record_pk)
    `,
      [
        prepared.recordIdBytes,
        actorCode(context.actor.principalKind),
        context.actor.principalId,
        request.boardId,
        request.idempotencyKey,
        request.command.type,
        prepared.fingerprintPayload,
        prepared.fingerprintPayload.byteLength,
        prepared.fingerprintSha256,
        context.actor.grantId,
        prepared.actorScopesPayload,
        prepared.actorScopesSha256,
        request.expectedRevisionId,
        prepared.commandPayloadSha256,
        request.requestId,
        prepared.occurredAtSql,
      ],
    );
    if (insert.affectedRows === 1) return { kind: 'new', recordPk: insertedPk(insert) };
    return { kind: 'replay', result: await this.replay(connection, context, request, prepared) };
  }

  async lockHead(
    connection: PoolConnection,
    request: MutationRequestV1,
  ): Promise<LockedControlMutationHeadV1> {
    return this.lockHeadForExpected(connection, request);
  }

  async lockHeadForExpected(
    connection: PoolConnection,
    request: Pick<MutationRequestV1, 'boardId' | 'expectedRevisionId'>,
  ): Promise<LockedControlMutationHeadV1> {
    const head = await this.lockCurrentHead(connection, request.boardId);
    if (head.headRevisionId !== request.expectedRevisionId) {
      throw revisionConflict(request, head.headRevisionId, head.headRevisionNumber);
    }
    return head;
  }

  async lockCurrentHead(
    connection: PoolConnection,
    boardId: BoardId,
    activeRequired = true,
  ): Promise<LockedControlMutationHeadV1> {
    const [rows] = await connection.execute<HeadRow[]>(
      `
      SELECT CAST(b.board_pk AS CHAR) AS boardPk, b.archived_at AS archivedAt,
             CAST(h.head_revision_pk AS CHAR) AS headRevisionPk,
             r.revision_id AS headRevisionId,
             CAST(h.head_revision_number AS CHAR) AS headRevisionNumber,
             CAST(h.last_event_sequence AS CHAR) AS lastEventSequence
      FROM boards b
      JOIN board_heads h ON h.board_pk = b.board_pk
      JOIN board_revisions r
        ON r.board_pk = h.board_pk AND r.revision_pk = h.head_revision_pk
      WHERE b.public_id = ?
      FOR UPDATE
    `,
      [boardId],
    );
    const row = rows[0];
    if (rows.length !== 1 || row === undefined || (activeRequired && row.archivedAt !== null)) {
      throw internalFailure();
    }
    const headRevisionId = formatPublicUuidV4(row.headRevisionId) as RevisionId;
    const headRevisionNumber = safeInteger(row.headRevisionNumber, false);
    return {
      boardPk: row.boardPk,
      headRevisionPk: row.headRevisionPk,
      headRevisionId,
      headRevisionNumber,
      lastEventSequence: safeInteger(row.lastEventSequence, true),
    };
  }

  async allocateSequence(
    connection: PoolConnection,
    head: LockedControlMutationHeadV1,
    prepared: PreparedControlMutationV1,
  ): Promise<number> {
    return this.allocateSequenceAt(connection, head, prepared.occurredAtSql);
  }

  async allocateSequenceAt(
    connection: PoolConnection,
    head: LockedControlMutationHeadV1,
    occurredAtSql: string,
  ): Promise<number> {
    if (head.lastEventSequence >= MAX_SAFE_SEQUENCE)
      throw new BoardPersistenceError('capacity_exhausted');
    const sequence = head.lastEventSequence + 1;
    const [update] = await connection.execute<ResultSetHeader>(
      `
      UPDATE board_heads
      SET last_event_sequence = ?, updated_at = ?
      WHERE board_pk = ? AND head_revision_pk = ? AND head_revision_number = ?
        AND last_event_sequence = ?
    `,
      [
        sequence,
        occurredAtSql,
        head.boardPk,
        head.headRevisionPk,
        head.headRevisionNumber,
        head.lastEventSequence,
      ],
    );
    if (update.affectedRows !== 1) throw internalFailure();
    return sequence;
  }

  async abandonPending(connection: PoolConnection, recordPk: bigint): Promise<void> {
    const [result] = await connection.execute<ResultSetHeader>(
      `
      DELETE FROM board_idempotency_records
      WHERE record_pk = ? AND status_code = 'P'
    `,
      [recordPk.toString()],
    );
    if (result.affectedRows !== 1) throw internalFailure();
  }

  async eventIdAtSequence(
    connection: PoolConnection,
    boardPk: string,
    sequence: number,
  ): Promise<EventId> {
    const [rows] = await connection.execute<ReplayEventRow[]>(
      `
      SELECT event_id AS eventId, CAST(board_pk AS CHAR) AS boardPk
      FROM board_event_outbox
      WHERE board_pk = ? AND sequence_number = ?
    `,
      [boardPk, sequence],
    );
    const row = rows[0];
    if (rows.length !== 1 || row === undefined || row.boardPk !== boardPk) throw internalFailure();
    return formatPublicUuidV4(row.eventId) as EventId;
  }

  async appendEvent(
    connection: PoolConnection,
    head: LockedControlMutationHeadV1,
    event: BoardEventEnvelopeV1,
  ): Promise<void> {
    const parsed = BoardEventEnvelopeParserV1.parse(event);
    if (!parsed.ok || event.revisionId !== null) throw internalFailure();
    const payload = Buffer.from(parsed.data.canonicalBytes);
    const [insert] = await connection.execute<ResultSetHeader>(
      `
      INSERT INTO board_event_outbox (
        event_id, board_pk, revision_pk, sequence_number, event_type,
        event_payload, event_canonical_bytes, event_sha256,
        status_code, occurred_at, delivered_at, retain_until
      ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, 'P', ?, NULL, NULL)
    `,
      [
        Buffer.from(parsePublicUuidV4(event.eventId)),
        head.boardPk,
        event.sequence,
        event.data.type,
        payload,
        payload.byteLength,
        digest(payload),
        formatProtocolTimestampUtcForMysql(event.occurredAt),
      ],
    );
    insertedPk(insert);
  }

  async complete(
    connection: PoolConnection,
    recordPk: bigint,
    head: LockedControlMutationHeadV1,
    prepared: PreparedControlMutationV1,
    result: MutationResultV1,
  ): Promise<MutationResultV1> {
    const parsed = MutationResultParserV1.parse(result);
    if (!parsed.ok || result.boardId === undefined) throw internalFailure();
    const payload = Buffer.from(parsed.data.canonicalBytes);
    const [update] = await connection.execute<ResultSetHeader>(
      `
      UPDATE board_idempotency_records
      SET status_code = 'C', result_payload = ?, result_canonical_bytes = ?,
          result_sha256 = ?, result_board_pk = ?, result_revision_pk = NULL,
          completed_at = ?, expires_at = ?
      WHERE record_pk = ? AND status_code = 'P'
    `,
      [
        payload,
        payload.byteLength,
        digest(payload),
        head.boardPk,
        prepared.occurredAtSql,
        prepared.expiresAtSql,
        recordPk.toString(),
      ],
    );
    if (update.affectedRows !== 1) throw internalFailure();
    return parsed.data.value;
  }

  private async replay(
    connection: PoolConnection,
    context: AuthorizedBoardContextV1,
    request: MutationRequestV1,
    prepared: PreparedControlMutationV1,
  ): Promise<MutationResultV1> {
    const [rows] = await connection.execute<IdempotencyRow[]>(
      `
      SELECT status_code AS statusCode, operation_type AS operationType,
             fingerprint_sha256 AS fingerprintSha256,
             actor_grant_id AS actorGrantId, actor_scopes_sha256 AS actorScopesSha256,
             expected_revision_id AS expectedRevisionId,
             command_payload_sha256 AS commandPayloadSha256,
             result_payload AS resultPayload, result_canonical_bytes AS resultCanonicalBytes,
             result_sha256 AS resultSha256, CAST(result_board_pk AS CHAR) AS resultBoardPk,
             CAST(result_revision_pk AS CHAR) AS resultRevisionPk
      FROM board_idempotency_records
      WHERE scope_code = 'M' AND principal_kind = ? AND principal_id = ?
        AND scope_subject = ? AND idempotency_key = ?
      FOR UPDATE
    `,
      [
        actorCode(context.actor.principalKind),
        context.actor.principalId,
        request.boardId,
        request.idempotencyKey,
      ],
    );
    const row = rows[0];
    if (rows.length !== 1 || row === undefined) throw internalFailure();
    if (!equalDigest(row.fingerprintSha256, prepared.fingerprintSha256)) {
      if (row.actorGrantId !== context.actor.grantId)
        throw idempotencyReuse(request, 'grant_changed');
      if (!equalDigest(row.actorScopesSha256, prepared.actorScopesSha256)) {
        throw idempotencyReuse(request, 'scopes_changed');
      }
      if (row.expectedRevisionId !== request.expectedRevisionId) {
        throw idempotencyReuse(request, 'expected_revision_changed');
      }
      if (
        row.operationType !== request.command.type ||
        !equalDigest(row.commandPayloadSha256, prepared.commandPayloadSha256)
      ) {
        throw idempotencyReuse(request, 'payload_changed');
      }
      throw internalFailure();
    }
    if (
      row.statusCode !== 'C' ||
      row.operationType !== request.command.type ||
      row.resultPayload === null ||
      row.resultCanonicalBytes !== row.resultPayload.byteLength ||
      row.resultSha256 === null ||
      !equalDigest(row.resultSha256, digest(row.resultPayload)) ||
      row.resultBoardPk === null ||
      row.resultRevisionPk !== null
    ) {
      throw internalFailure();
    }
    const stored = MutationResultParserV1.parseBytes(row.resultPayload);
    if (
      !stored.ok ||
      stored.data.value.boardId !== request.boardId ||
      stored.data.value.result.type !== request.command.type
    )
      throw internalFailure();
    await this.assertReplayEvents(connection, row.resultBoardPk, stored.data.value.eventIds);
    const replayed = MutationResultParserV1.parse({
      ...stored.data.value,
      requestId: request.requestId,
      replayed: true,
    });
    if (!replayed.ok) throw internalFailure();
    return replayed.data.value;
  }

  private async assertReplayEvents(
    connection: PoolConnection,
    boardPk: string,
    eventIds: readonly EventId[],
  ): Promise<void> {
    if (eventIds.length === 0) return;
    const placeholders = eventIds.map(() => '?').join(', ');
    const [rows] = await connection.execute<ReplayEventRow[]>(
      `
      SELECT event_id AS eventId, CAST(board_pk AS CHAR) AS boardPk
      FROM board_event_outbox
      WHERE event_id IN (${placeholders})
    `,
      eventIds.map((eventId) => Buffer.from(parsePublicUuidV4(eventId))),
    );
    if (rows.length !== eventIds.length || rows.some((row) => row.boardPk !== boardPk)) {
      throw internalFailure();
    }
    const actual = rows.map((row) => formatPublicUuidV4(row.eventId)).sort();
    const expected = [...eventIds].sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) throw internalFailure();
  }
}
