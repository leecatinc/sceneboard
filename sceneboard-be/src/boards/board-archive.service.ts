import { createHash, timingSafeEqual } from 'node:crypto';

import {
  BoardOperationResultParserV1,
  BoardIdParserV1,
  buildBoardOperationFingerprintV1,
  canonicalizeJsonV1,
  type BoardId,
  type BoardLifecycleIdempotencyEnvelopeV1,
  type BoardOperationResultV1,
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
import { formatMysqlTimestampUtc, parseMysqlTimestampUtc } from '../common/time/mysql-timestamp.js';
import type {
  AuthorizedBoardContextV1,
  BoardAccessPolicy,
  ResolvedBoardPrincipalV1,
} from '../grants/board-access.policy.js';

export type BoardArchiveRequestV1 = Extract<
  BoardLifecycleIdempotencyEnvelopeV1['request'],
  { type: 'board.archive' }
>;

interface ArchiveRuntime {
  now(): Date;
  generateUuid(): string;
}

interface PreparedArchiveV1 {
  recordIdBytes: Buffer;
  occurredAt: TimestampV1;
  occurredAtSql: string;
  expiresAtSql: string;
  fingerprintPayload: Buffer;
  fingerprintSha256: Buffer;
  actorScopesPayload: Buffer;
  actorScopesSha256: Buffer;
  commandPayloadSha256: Buffer;
}

interface ArchiveIdempotencyRow extends RowDataPacket {
  statusCode: string;
  operationType: string;
  fingerprintSha256: Buffer;
  actorGrantId: string | null;
  actorScopesSha256: Buffer;
  resultPayload: Buffer | null;
  resultCanonicalBytes: number | null;
  resultSha256: Buffer | null;
  resultBoardPk: string | null;
  resultRevisionPk: string | null;
}

interface ArchiveHeadRow extends RowDataPacket {
  boardPk: string;
  boardId: string;
  title: string;
  boardCreatedAt: string;
  boardUpdatedAt: string;
  archivedAt: string | null;
  headRevisionPk: string;
  headRevisionId: Buffer;
  headRevisionNumber: string;
  headRevisionCreatedAt: string;
}

interface ArchiveReplayRelationRow extends RowDataPacket {
  boardId: string;
  revisionId: Buffer;
}

class ArchiveRecordCollisionError extends Error {}

const digest = (value: Uint8Array): Buffer => createHash('sha256').update(value).digest();
const digestEquals = (left: Uint8Array, right: Uint8Array): boolean =>
  left.byteLength === right.byteLength && timingSafeEqual(Buffer.from(left), Buffer.from(right));
const canonicalBytes = (value: unknown): Buffer => {
  const parsed = canonicalizeJsonV1(value);
  if (!parsed.ok) throw internalFailure();
  return Buffer.from(parsed.data.canonicalBytes);
};
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
const archivedFailure = (boardId: BoardId, archivedAt: TimestampV1): BoardContractError =>
  new BoardContractError({
    protocolVersion: 1,
    type: 'board.error',
    code: 'BOARD_ALREADY_ARCHIVED',
    message: 'Board is already archived',
    category: 'conflict',
    retryable: false,
    httpStatusHint: 409,
    details: { boardId, archivedAt },
  });
const idempotencyReuse = (
  request: BoardArchiveRequestV1,
  reason: 'grant_changed' | 'scopes_changed',
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
      scope: 'board.archive',
      boardId: request.boardId,
      operationType: 'board.archive',
      reason,
    },
  });
const actorCode = (kind: AuthorizedBoardContextV1['actor']['principalKind']): 'U' | 'M' | 'S' =>
  kind === 'user' ? 'U' : kind === 'mcp_client' ? 'M' : 'S';
const timestamp = (value: string): TimestampV1 => {
  try {
    return parseMysqlTimestampUtc(value).toISOString() as TimestampV1;
  } catch (error) {
    throw new BoardPersistenceError('row_integrity', error);
  }
};
const boardId = (value: string): BoardId => {
  const parsed = BoardIdParserV1.parse(value);
  if (!parsed.ok) throw new BoardPersistenceError('row_integrity');
  return parsed.data.value;
};
const revisionId = (value: Uint8Array): RevisionId => formatPublicUuidV4(value) as RevisionId;
const positive = (value: string): number => {
  if (!/^[1-9][0-9]{0,15}$/.test(value)) throw new BoardPersistenceError('row_integrity');
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

export class BoardArchiveService {
  private readonly runtime: ArchiveRuntime;

  constructor(
    private readonly accessPolicy: BoardAccessPolicy,
    runtime: Partial<ArchiveRuntime> = {},
  ) {
    this.runtime = {
      now: runtime.now ?? (() => new Date()),
      generateUuid: runtime.generateUuid ?? (() => generatePublicUuidV4()),
    };
  }

  async archive(input: {
    principal: ResolvedBoardPrincipalV1;
    request: BoardArchiveRequestV1;
  }): Promise<BoardOperationResultV1> {
    let prepared = this.prepare(input);
    for (let collisionCount = 0; collisionCount <= 3; collisionCount += 1) {
      try {
        return await this.accessPolicy.withAuthorizedBoardTransaction(
          {
            principal: input.principal,
            operation: 'board.archive',
            boardId: input.request.boardId,
            isolation: 'READ_COMMITTED_WRITE',
          },
          async (connection, context) =>
            this.applyNewOrReplay(connection, context, input.request, prepared),
        );
      } catch (error) {
        if (!(error instanceof ArchiveRecordCollisionError)) throw error;
        if (collisionCount === 3) throw internalFailure();
        prepared = {
          ...prepared,
          recordIdBytes: Buffer.from(parsePublicUuidV4(this.runtime.generateUuid())),
        };
      }
    }
    throw internalFailure();
  }

  private prepare(input: {
    principal: ResolvedBoardPrincipalV1;
    request: BoardArchiveRequestV1;
  }): PreparedArchiveV1 {
    const fingerprint = buildBoardOperationFingerprintV1({
      protocolVersion: 1,
      type: 'board.operation.envelope',
      request: input.request,
      actor: input.principal.actor,
    });
    if (!fingerprint.ok) throw new BoardContractError(fingerprint.error);
    const fingerprintPayload = Buffer.from(fingerprint.data.canonicalBytes);
    const scopes = canonicalBytes(input.principal.actor.scopes);
    const command = canonicalBytes({ boardId: input.request.boardId, confirm: true });
    const now = this.runtime.now();
    if (!Number.isFinite(now.valueOf())) throw internalFailure();
    return {
      recordIdBytes: Buffer.from(parsePublicUuidV4(this.runtime.generateUuid())),
      occurredAt: now.toISOString() as TimestampV1,
      occurredAtSql: formatMysqlTimestampUtc(now),
      expiresAtSql: formatMysqlTimestampUtc(new Date(now.valueOf() + 30 * 24 * 60 * 60 * 1_000)),
      fingerprintPayload,
      fingerprintSha256: digest(fingerprintPayload),
      actorScopesPayload: scopes,
      actorScopesSha256: digest(scopes),
      commandPayloadSha256: digest(command),
    };
  }

  private async applyNewOrReplay(
    connection: PoolConnection,
    context: AuthorizedBoardContextV1,
    request: BoardArchiveRequestV1,
    prepared: PreparedArchiveV1,
  ): Promise<BoardOperationResultV1> {
    const [pending] = await connection.execute<ResultSetHeader>(
      `
      INSERT INTO board_idempotency_records (
        record_id, scope_code, principal_kind, principal_id, scope_subject,
        idempotency_key, operation_type, fingerprint_version, fingerprint_payload,
        fingerprint_canonical_bytes, fingerprint_sha256, actor_grant_id,
        actor_scopes_payload, actor_scopes_sha256, expected_revision_id,
        command_payload_sha256, initial_request_id, status_code, created_at
      ) VALUES (?, 'A', ?, ?, ?, ?, 'board.archive', 1, ?, ?, ?, ?, ?, ?, NULL, ?, ?, 'P', ?)
      ON DUPLICATE KEY UPDATE record_pk = LAST_INSERT_ID(record_pk)
    `,
      [
        prepared.recordIdBytes,
        actorCode(context.actor.principalKind),
        context.actor.principalId,
        request.boardId,
        request.idempotencyKey,
        prepared.fingerprintPayload,
        prepared.fingerprintPayload.byteLength,
        prepared.fingerprintSha256,
        context.actor.grantId,
        prepared.actorScopesPayload,
        prepared.actorScopesSha256,
        prepared.commandPayloadSha256,
        request.requestId,
        prepared.occurredAtSql,
      ],
    );
    if (pending.affectedRows !== 1)
      return this.replayOrReject(connection, context, request, prepared);
    const recordPk = insertedPk(pending);
    const head = await this.lockHead(connection, request.boardId);
    if (head.archivedAt !== null)
      throw archivedFailure(request.boardId, timestamp(head.archivedAt));
    const [archive] = await connection.execute<ResultSetHeader>(
      `
      UPDATE boards
      SET archived_at = ?, updated_at = ?,
          archived_by_kind = ?, archived_by_principal_id = ?, archived_by_grant_id = ?
      WHERE board_pk = ? AND archived_at IS NULL
    `,
      [
        prepared.occurredAtSql,
        prepared.occurredAtSql,
        actorCode(context.actor.principalKind),
        context.actor.principalId,
        context.actor.grantId,
        head.boardPk,
      ],
    );
    if (archive.affectedRows !== 1) throw internalFailure();
    const result = BoardOperationResultParserV1.parse({
      protocolVersion: 1,
      type: 'board.operation.result',
      requestId: request.requestId,
      replayed: false,
      result: {
        type: 'board.archive',
        board: {
          boardId: boardId(head.boardId),
          title: head.title,
          createdAt: timestamp(head.boardCreatedAt),
          updatedAt: prepared.occurredAt,
          archivedAt: prepared.occurredAt,
          headRevision: {
            revisionId: revisionId(head.headRevisionId),
            revisionNumber: positive(head.headRevisionNumber),
            createdAt: timestamp(head.headRevisionCreatedAt),
          },
        },
      },
    });
    if (!result.ok || result.data.value.result.type !== 'board.archive') throw internalFailure();
    const payload = Buffer.from(result.data.canonicalBytes);
    const [complete] = await connection.execute<ResultSetHeader>(
      `
      UPDATE board_idempotency_records
      SET status_code = 'C', result_payload = ?, result_canonical_bytes = ?, result_sha256 = ?,
          result_board_pk = ?, result_revision_pk = ?, completed_at = ?, expires_at = ?
      WHERE record_pk = ? AND status_code = 'P'
    `,
      [
        payload,
        payload.byteLength,
        digest(payload),
        head.boardPk,
        head.headRevisionPk,
        prepared.occurredAtSql,
        prepared.expiresAtSql,
        recordPk.toString(),
      ],
    );
    if (complete.affectedRows !== 1) throw internalFailure();
    return result.data.value;
  }

  private async lockHead(
    connection: PoolConnection,
    expectedBoardId: BoardId,
  ): Promise<ArchiveHeadRow> {
    const [rows] = await connection.execute<ArchiveHeadRow[]>(
      `
      SELECT CAST(b.board_pk AS CHAR) AS boardPk, b.public_id AS boardId, b.title,
             b.created_at AS boardCreatedAt, b.updated_at AS boardUpdatedAt,
             b.archived_at AS archivedAt,
             CAST(h.head_revision_pk AS CHAR) AS headRevisionPk,
             r.revision_id AS headRevisionId,
             CAST(h.head_revision_number AS CHAR) AS headRevisionNumber,
             r.created_at AS headRevisionCreatedAt
      FROM boards b
      JOIN board_heads h ON h.board_pk = b.board_pk
      JOIN board_revisions r
        ON r.board_pk = h.board_pk AND r.revision_pk = h.head_revision_pk
          AND r.revision_number = h.head_revision_number
      WHERE b.public_id = ?
      FOR UPDATE
    `,
      [expectedBoardId],
    );
    const row = rows[0];
    if (rows.length !== 1 || row === undefined || boardId(row.boardId) !== expectedBoardId) {
      throw new BoardPersistenceError('row_integrity');
    }
    return row;
  }

  private async replayOrReject(
    connection: PoolConnection,
    context: AuthorizedBoardContextV1,
    request: BoardArchiveRequestV1,
    prepared: PreparedArchiveV1,
  ): Promise<BoardOperationResultV1> {
    const [rows] = await connection.execute<ArchiveIdempotencyRow[]>(
      `
      SELECT status_code AS statusCode, operation_type AS operationType,
             fingerprint_sha256 AS fingerprintSha256,
             actor_grant_id AS actorGrantId, actor_scopes_sha256 AS actorScopesSha256,
             result_payload AS resultPayload, result_canonical_bytes AS resultCanonicalBytes,
             result_sha256 AS resultSha256,
             CAST(result_board_pk AS CHAR) AS resultBoardPk,
             CAST(result_revision_pk AS CHAR) AS resultRevisionPk
      FROM board_idempotency_records
      WHERE scope_code = 'A' AND principal_kind = ? AND principal_id = ?
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
    if (rows.length === 0) throw new ArchiveRecordCollisionError();
    if (rows.length !== 1 || row === undefined || row.operationType !== 'board.archive')
      throw internalFailure();
    if (!digestEquals(row.fingerprintSha256, prepared.fingerprintSha256)) {
      if (row.actorGrantId !== context.actor.grantId)
        throw idempotencyReuse(request, 'grant_changed');
      if (!digestEquals(row.actorScopesSha256, prepared.actorScopesSha256)) {
        throw idempotencyReuse(request, 'scopes_changed');
      }
      throw internalFailure();
    }
    if (
      row.statusCode !== 'C' ||
      row.resultPayload === null ||
      row.resultCanonicalBytes === null ||
      row.resultSha256 === null ||
      row.resultBoardPk === null ||
      row.resultRevisionPk === null ||
      row.resultCanonicalBytes !== row.resultPayload.byteLength ||
      !digestEquals(digest(row.resultPayload), row.resultSha256)
    )
      throw internalFailure();
    const stored = BoardOperationResultParserV1.parseBytes(row.resultPayload);
    if (
      !stored.ok ||
      !Buffer.from(stored.data.canonicalBytes).equals(row.resultPayload) ||
      stored.data.value.replayed ||
      stored.data.value.result.type !== 'board.archive' ||
      stored.data.value.result.board.boardId !== request.boardId
    )
      throw internalFailure();
    const [relations] = await connection.execute<ArchiveReplayRelationRow[]>(
      `
      SELECT b.public_id AS boardId, r.revision_id AS revisionId
      FROM boards b
      JOIN board_revisions r ON r.board_pk = b.board_pk AND r.revision_pk = ?
      WHERE b.board_pk = ?
      LIMIT 1
    `,
      [row.resultRevisionPk, row.resultBoardPk],
    );
    const relation = relations[0];
    if (
      relations.length !== 1 ||
      relation === undefined ||
      relation.boardId !== request.boardId ||
      relation.boardId !== stored.data.value.result.board.boardId ||
      revisionId(relation.revisionId) !== stored.data.value.result.board.headRevision.revisionId
    ) {
      throw internalFailure();
    }
    const replay = BoardOperationResultParserV1.parse({
      ...stored.data.value,
      requestId: request.requestId,
      replayed: true,
    });
    if (!replay.ok) throw internalFailure();
    return replay.data.value;
  }
}
