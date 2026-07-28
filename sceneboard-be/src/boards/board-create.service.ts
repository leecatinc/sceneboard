import { createHash, timingSafeEqual } from 'node:crypto';

import {
  BoardEventEnvelopeParserV1,
  BoardIdParserV1,
  BoardOperationResultParserV1,
  buildBoardOperationFingerprintV1,
  canonicalizeJsonV1,
  type BoardId,
  type BoardLifecycleIdempotencyEnvelopeV1,
  type BoardOperationResultV1,
  type EventId,
  type RevisionId,
  type TimestampV1,
} from '@sceneboard/board-schema';
import type { PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';

import { BoardContractError } from '../common/errors/app-error.js';
import {
  formatPublicUuidV4,
  generatePublicUuidV4,
  parsePublicUuidV4,
} from '../common/ids/public-uuid.storage.js';
import { CryptoService } from '../common/security/crypto.service.js';
import { formatMysqlTimestampUtc } from '../common/time/mysql-timestamp.js';
import type {
  AuthorizedBoardContextV1,
  BoardAccessPolicy,
  ResolvedBoardPrincipalV1,
} from '../grants/board-access.policy.js';
import { DocumentCheckpointCodec } from '../revisions/document-checkpoint.codec.js';
import { currentBoardCapabilitiesFromContext } from '../grants/current-board-capabilities.js';

export type BoardCreateRequestV1 = Extract<
  BoardLifecycleIdempotencyEnvelopeV1['request'],
  { type: 'board.create' }
>;

interface BoardCreateRuntime {
  now: () => Date;
  generateUuid: () => string;
}

interface PreparedCreateV1 {
  boardId: BoardId;
  revisionId: RevisionId;
  revisionIdBytes: Buffer;
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
  checkpoint: Awaited<ReturnType<DocumentCheckpointCodec['encodeScene']>>;
}

interface CreateIdempotencyRow extends RowDataPacket {
  recordPk: string;
  statusCode: string;
  operationType: string;
  fingerprintSha256: Buffer;
  actorGrantId: string | null;
  actorScopesSha256: Buffer;
  commandPayloadSha256: Buffer;
  resultPayload: Buffer | null;
  resultCanonicalBytes: number | null;
  resultSha256: Buffer | null;
  resultBoardPk: string | null;
  resultRevisionPk: string | null;
}

interface CreateReplayRelationRow extends RowDataPacket {
  boardId: string;
  revisionId: Buffer;
}

type CreateCollisionKind = 'board' | 'revision' | 'event' | 'record';

export class BoardCreateIdentifierCollisionError extends Error {
  constructor(readonly kind: CreateCollisionKind) {
    super(`create identifier collision: ${kind}`);
    this.name = 'BoardCreateIdentifierCollisionError';
  }
}

const hash = (value: Uint8Array): Buffer => createHash('sha256').update(value).digest();
const digestEquals = (left: Uint8Array, right: Uint8Array): boolean =>
  left.byteLength === right.byteLength && timingSafeEqual(Buffer.from(left), Buffer.from(right));

const isNamedDuplicate = (error: unknown, constraint: string): boolean => {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as {
    errno?: unknown;
    code?: unknown;
    sqlMessage?: unknown;
    message?: unknown;
  };
  if (candidate.errno !== 1062 && candidate.code !== 'ER_DUP_ENTRY') return false;
  const message =
    typeof candidate.sqlMessage === 'string'
      ? candidate.sqlMessage
      : typeof candidate.message === 'string'
        ? candidate.message
        : '';
  return message.includes(constraint);
};

const internalFailure = (): BoardContractError =>
  new BoardContractError({
    protocolVersion: 1,
    type: 'board.error',
    code: 'INTERNAL_ERROR',
    message: 'Internal server error',
    category: 'internal',
    retryable: false,
    httpStatusHint: 500,
    details: null,
  });

const idempotencyReuse = (
  reason: 'grant_changed' | 'scopes_changed' | 'title_changed',
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
      scope: 'board.create',
      boardId: null,
      operationType: 'board.create',
      reason,
    },
  });

const canonicalBytes = (value: unknown): Buffer => {
  const result = canonicalizeJsonV1(value);
  if (!result.ok) throw internalFailure();
  return Buffer.from(result.data.canonicalBytes);
};

const insertedPk = (result: ResultSetHeader): bigint => {
  if (result.affectedRows !== 1 || !Number.isSafeInteger(result.insertId) || result.insertId < 1) {
    throw internalFailure();
  }
  return BigInt(result.insertId);
};

const actorKindCode = (
  kind: AuthorizedBoardContextV1['actor']['principalKind'],
): 'U' | 'M' | 'S' => {
  if (kind === 'user') return 'U';
  if (kind === 'mcp_client') return 'M';
  return 'S';
};

const asBoardId = (value: string): BoardId => {
  const parsed = BoardIdParserV1.parse(value);
  if (!parsed.ok || value.length !== 22) throw internalFailure();
  return parsed.data.value;
};

const asTimestamp = (value: Date): TimestampV1 => value.toISOString() as TimestampV1;
const asRevisionId = (value: string): RevisionId => value as RevisionId;
const asEventId = (value: string): EventId => value as EventId;

export class BoardCreateService {
  private readonly runtime: BoardCreateRuntime;

  constructor(
    private readonly accessPolicy: BoardAccessPolicy,
    private readonly crypto: CryptoService,
    private readonly checkpointCodec: DocumentCheckpointCodec,
    runtime: Partial<BoardCreateRuntime> = {},
  ) {
    this.runtime = {
      now: runtime.now ?? (() => new Date()),
      generateUuid: runtime.generateUuid ?? (() => generatePublicUuidV4()),
    };
  }

  async create(input: {
    principal: ResolvedBoardPrincipalV1;
    request: BoardCreateRequestV1;
  }): Promise<BoardOperationResultV1> {
    let prepared = await this.prepare({ actor: input.principal.actor, request: input.request });
    for (let collisionCount = 0; collisionCount <= 3; collisionCount += 1) {
      try {
        return await this.accessPolicy.withAuthorizedBoardTransaction(
          {
            principal: input.principal,
            operation: 'board.create',
            boardId: null,
            isolation: 'READ_COMMITTED_WRITE',
          },
          async (connection, context) =>
            this.insertNewCreate(connection, context, input.request, prepared),
        );
      } catch (error) {
        if (!(error instanceof BoardCreateIdentifierCollisionError)) throw error;
        if (collisionCount === 3) throw internalFailure();
        prepared = this.regenerateCollision(prepared, error.kind);
      }
    }
    throw internalFailure();
  }

  async createInTransaction(input: {
    connection: PoolConnection;
    context: AuthorizedBoardContextV1;
    request: BoardCreateRequestV1;
  }): Promise<BoardOperationResultV1> {
    const prepared = await this.prepare({ actor: input.context.actor, request: input.request });
    return this.insertNewCreate(input.connection, input.context, input.request, prepared);
  }

  private regenerateCollision(
    prepared: PreparedCreateV1,
    kind: CreateCollisionKind,
  ): PreparedCreateV1 {
    if (kind === 'board')
      return { ...prepared, boardId: asBoardId(this.crypto.generatePublicIdV1()) };
    const uuid = this.runtime.generateUuid();
    const bytes = Buffer.from(parsePublicUuidV4(uuid));
    if (kind === 'revision')
      return { ...prepared, revisionId: asRevisionId(uuid), revisionIdBytes: bytes };
    if (kind === 'event') return { ...prepared, eventId: asEventId(uuid), eventIdBytes: bytes };
    return { ...prepared, recordIdBytes: bytes };
  }

  private async prepare(input: {
    actor: ResolvedBoardPrincipalV1['actor'];
    request: BoardCreateRequestV1;
  }): Promise<PreparedCreateV1> {
    const fingerprint = buildBoardOperationFingerprintV1({
      protocolVersion: 1,
      type: 'board.operation.envelope',
      request: input.request,
      actor: input.actor,
    });
    if (!fingerprint.ok) throw new BoardContractError(fingerprint.error);
    const fingerprintPayload = Buffer.from(fingerprint.data.canonicalBytes);
    const actorScopesPayload = canonicalBytes(input.actor.scopes);
    const commandPayload = canonicalBytes({ title: input.request.title });
    const idempotencyScope = canonicalBytes({
      scope: 'board.create',
      principalKind: input.actor.principalKind,
      principalId: input.actor.principalId,
      idempotencyKey: input.request.idempotencyKey,
    });
    const now = this.runtime.now();
    if (!Number.isFinite(now.valueOf())) throw internalFailure();
    const expiresAt = new Date(now.valueOf() + 30 * 24 * 60 * 60 * 1_000);
    const revisionUuid = this.runtime.generateUuid();
    const eventUuid = this.runtime.generateUuid();
    const recordUuid = this.runtime.generateUuid();
    return {
      boardId: asBoardId(this.crypto.generatePublicIdV1()),
      revisionId: asRevisionId(revisionUuid),
      revisionIdBytes: Buffer.from(parsePublicUuidV4(revisionUuid)),
      eventId: asEventId(eventUuid),
      eventIdBytes: Buffer.from(parsePublicUuidV4(eventUuid)),
      recordIdBytes: Buffer.from(parsePublicUuidV4(recordUuid)),
      occurredAt: asTimestamp(now),
      occurredAtSql: formatMysqlTimestampUtc(now),
      expiresAtSql: formatMysqlTimestampUtc(expiresAt),
      fingerprintPayload,
      fingerprintSha256: hash(fingerprintPayload),
      actorScopesPayload,
      actorScopesSha256: hash(actorScopesPayload),
      commandPayloadSha256: hash(commandPayload),
      idempotencyScopeSha256: hash(idempotencyScope),
      checkpoint: await this.checkpointCodec.encodeScene({
        protocolVersion: 1,
        type: 'scene',
        root: null,
      }),
    };
  }

  private async insertNewCreate(
    connection: PoolConnection,
    context: AuthorizedBoardContextV1,
    request: BoardCreateRequestV1,
    prepared: PreparedCreateV1,
  ): Promise<BoardOperationResultV1> {
    const actorCode = actorKindCode(context.actor.principalKind);
    const [idempotency] = await connection.execute<ResultSetHeader>(
      `
      INSERT INTO board_idempotency_records (
        record_id, scope_code, principal_kind, principal_id, scope_subject,
        idempotency_key, operation_type, fingerprint_version, fingerprint_payload,
        fingerprint_canonical_bytes, fingerprint_sha256, actor_grant_id,
        actor_scopes_payload, actor_scopes_sha256, expected_revision_id,
        command_payload_sha256, initial_request_id, status_code, created_at
      ) VALUES (?, 'C', ?, ?, 'board.create', ?, 'board.create', 1, ?, ?, ?, ?, ?, ?, NULL, ?, ?, 'P', ?)
      ON DUPLICATE KEY UPDATE record_pk = LAST_INSERT_ID(record_pk)
    `,
      [
        prepared.recordIdBytes,
        actorCode,
        context.actor.principalId,
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
    if (idempotency.affectedRows !== 1) {
      return this.replayOrReject(connection, context, request, prepared);
    }
    const recordPk = insertedPk(idempotency);

    let boardInsert: ResultSetHeader;
    try {
      [boardInsert] = await connection.execute<ResultSetHeader>(
        `
        INSERT INTO boards (
          public_id, title, owner_user_id,
          created_by_kind, created_by_principal_id, created_by_grant_id,
          created_at, updated_at, archived_at,
          archived_by_kind, archived_by_principal_id, archived_by_grant_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL)
      `,
        [
          prepared.boardId,
          request.title,
          context.ownerUserPk.toString(),
          actorCode,
          context.actor.principalId,
          context.actor.grantId,
          prepared.occurredAtSql,
          prepared.occurredAtSql,
        ],
      );
    } catch (error) {
      if (isNamedDuplicate(error, 'uq_boards_public_id'))
        throw new BoardCreateIdentifierCollisionError('board');
      throw error;
    }
    const boardPk = insertedPk(boardInsert);
    if (context.createBinding !== null) {
      await context.createBinding.bindCreatedBoard(prepared.boardId);
    }

    let revisionInsert: ResultSetHeader;
    try {
      [revisionInsert] = await connection.execute<ResultSetHeader>(
        `
        INSERT INTO board_revisions (
          revision_id, board_pk, revision_number, previous_revision_pk, source_revision_pk,
          origin_code, label, scene_schema_version, scene_codec, scene_payload,
          scene_canonical_bytes, scene_stored_bytes, scene_sha256,
          actor_kind, actor_principal_id, actor_grant_id,
          request_id, idempotency_scope_sha256, created_at
        ) VALUES (?, ?, 1, NULL, NULL, 'C', 'Created', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
        [
          prepared.revisionIdBytes,
          boardPk.toString(),
          prepared.checkpoint.schemaVersion,
          prepared.checkpoint.codec,
          prepared.checkpoint.payload,
          prepared.checkpoint.canonicalBytes,
          prepared.checkpoint.storedBytes,
          prepared.checkpoint.sha256,
          actorCode,
          context.actor.principalId,
          context.actor.grantId,
          request.requestId,
          prepared.idempotencyScopeSha256,
          prepared.occurredAtSql,
        ],
      );
    } catch (error) {
      if (isNamedDuplicate(error, 'uq_revisions_revision_id')) {
        throw new BoardCreateIdentifierCollisionError('revision');
      }
      throw error;
    }
    const revisionPk = insertedPk(revisionInsert);

    const [headInsert] = await connection.execute<ResultSetHeader>(
      `
      INSERT INTO board_heads (
        board_pk, head_revision_pk, head_revision_number, last_event_sequence, updated_at
      ) VALUES (?, ?, 1, 1, ?)
    `,
      [boardPk.toString(), revisionPk.toString(), prepared.occurredAtSql],
    );
    if (headInsert.affectedRows !== 1) throw internalFailure();

    const revision = {
      revisionId: prepared.revisionId,
      revisionNumber: 1,
      createdAt: prepared.occurredAt,
    };
    const eventCandidate = {
      protocolVersion: 1 as const,
      type: 'board.event' as const,
      boardId: prepared.boardId,
      eventId: prepared.eventId,
      sequence: 1,
      occurredAt: prepared.occurredAt,
      revisionId: prepared.revisionId,
      data: {
        type: 'board.revision.created' as const,
        revision,
        originType: 'board.create' as const,
        sourceRevisionId: null,
      },
    };
    const parsedEvent = BoardEventEnvelopeParserV1.parse(eventCandidate);
    if (!parsedEvent.ok) throw internalFailure();
    const eventPayload = Buffer.from(parsedEvent.data.canonicalBytes);
    let eventInsert: ResultSetHeader;
    try {
      [eventInsert] = await connection.execute<ResultSetHeader>(
        `
        INSERT INTO board_event_outbox (
          event_id, board_pk, revision_pk, sequence_number, event_type,
          event_payload, event_canonical_bytes, event_sha256,
          status_code, occurred_at, delivered_at, retain_until
        ) VALUES (?, ?, ?, 1, 'board.revision.created', ?, ?, ?, 'P', ?, NULL, NULL)
      `,
        [
          prepared.eventIdBytes,
          boardPk.toString(),
          revisionPk.toString(),
          eventPayload,
          eventPayload.byteLength,
          hash(eventPayload),
          prepared.occurredAtSql,
        ],
      );
    } catch (error) {
      if (isNamedDuplicate(error, 'uq_outbox_event_id'))
        throw new BoardCreateIdentifierCollisionError('event');
      throw error;
    }
    insertedPk(eventInsert);

    const capabilities = currentBoardCapabilitiesFromContext(context);
    const resultCandidate = {
      protocolVersion: 1 as const,
      type: 'board.operation.result' as const,
      requestId: request.requestId,
      replayed: false,
      result: {
        type: 'board.create' as const,
        board: {
          boardId: prepared.boardId,
          title: request.title,
          createdAt: prepared.occurredAt,
          updatedAt: prepared.occurredAt,
          archivedAt: null,
          headRevision: revision,
        },
        snapshot: {
          protocolVersion: 1 as const,
          type: 'board.snapshot' as const,
          boardId: prepared.boardId,
          revision: {
            ...revision,
            previousRevisionId: null,
            originType: 'board.create' as const,
            sourceRevisionId: null,
            actor: {
              principalKind: context.actor.principalKind,
              principalId: context.actor.principalId,
            },
          },
          scene: { protocolVersion: 1 as const, type: 'scene' as const, root: null },
          hitl: [],
          artifacts: [],
          capabilities,
          lastEventSequence: 1,
        },
      },
    };
    const parsedResult = BoardOperationResultParserV1.parse(resultCandidate);
    if (!parsedResult.ok) throw internalFailure();
    const resultPayload = Buffer.from(parsedResult.data.canonicalBytes);
    const [completion] = await connection.execute<ResultSetHeader>(
      `
      UPDATE board_idempotency_records
      SET status_code = 'C',
          result_payload = ?, result_canonical_bytes = ?, result_sha256 = ?,
          result_board_pk = ?, result_revision_pk = ?,
          completed_at = ?, expires_at = ?
      WHERE record_pk = ? AND status_code = 'P'
    `,
      [
        resultPayload,
        resultPayload.byteLength,
        hash(resultPayload),
        boardPk.toString(),
        revisionPk.toString(),
        prepared.occurredAtSql,
        prepared.expiresAtSql,
        recordPk.toString(),
      ],
    );
    if (completion.affectedRows !== 1) throw internalFailure();
    return parsedResult.data.value;
  }

  private async replayOrReject(
    connection: PoolConnection,
    context: AuthorizedBoardContextV1,
    request: BoardCreateRequestV1,
    prepared: PreparedCreateV1,
  ): Promise<BoardOperationResultV1> {
    const [rows] = await connection.execute<CreateIdempotencyRow[]>(
      `
      SELECT
        CAST(record_pk AS CHAR) AS recordPk,
        status_code AS statusCode,
        operation_type AS operationType,
        fingerprint_sha256 AS fingerprintSha256,
        actor_grant_id AS actorGrantId,
        actor_scopes_sha256 AS actorScopesSha256,
        command_payload_sha256 AS commandPayloadSha256,
        result_payload AS resultPayload,
        result_canonical_bytes AS resultCanonicalBytes,
        result_sha256 AS resultSha256,
        CAST(result_board_pk AS CHAR) AS resultBoardPk,
        CAST(result_revision_pk AS CHAR) AS resultRevisionPk
      FROM board_idempotency_records
      WHERE scope_code = 'C'
        AND principal_kind = ?
        AND principal_id = ?
        AND scope_subject = 'board.create'
        AND idempotency_key = ?
      FOR UPDATE
    `,
      [
        actorKindCode(context.actor.principalKind),
        context.actor.principalId,
        request.idempotencyKey,
      ],
    );
    const row = rows[0];
    if (rows.length === 0) throw new BoardCreateIdentifierCollisionError('record');
    if (rows.length !== 1 || row === undefined || row.operationType !== 'board.create')
      throw internalFailure();
    if (!digestEquals(row.fingerprintSha256, prepared.fingerprintSha256)) {
      if (row.actorGrantId !== context.actor.grantId) throw idempotencyReuse('grant_changed');
      if (!digestEquals(row.actorScopesSha256, prepared.actorScopesSha256)) {
        throw idempotencyReuse('scopes_changed');
      }
      if (!digestEquals(row.commandPayloadSha256, prepared.commandPayloadSha256)) {
        throw idempotencyReuse('title_changed');
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
      row.resultPayload.byteLength < 1 ||
      row.resultPayload.byteLength > 1_048_576 ||
      !digestEquals(hash(row.resultPayload), row.resultSha256)
    ) {
      throw internalFailure();
    }
    const parsedStored = BoardOperationResultParserV1.parseBytes(row.resultPayload);
    if (
      !parsedStored.ok ||
      !Buffer.from(parsedStored.data.canonicalBytes).equals(row.resultPayload) ||
      parsedStored.data.value.replayed ||
      parsedStored.data.value.result.type !== 'board.create'
    ) {
      throw internalFailure();
    }
    const stored = parsedStored.data.value;
    if (stored.result.type !== 'board.create') throw internalFailure();
    const [relations] = await connection.execute<CreateReplayRelationRow[]>(
      `
      SELECT b.public_id AS boardId, r.revision_id AS revisionId
      FROM boards b
      JOIN board_revisions r
        ON r.board_pk = b.board_pk AND r.revision_pk = ?
      WHERE b.board_pk = ?
      LIMIT 1
    `,
      [row.resultRevisionPk, row.resultBoardPk],
    );
    const relation = relations[0];
    if (
      relations.length !== 1 ||
      relation === undefined ||
      asBoardId(relation.boardId) !== stored.result.board.boardId ||
      asRevisionIdFromBytes(relation.revisionId) !== stored.result.board.headRevision.revisionId ||
      stored.result.snapshot.revision.revisionId !== stored.result.board.headRevision.revisionId
    ) {
      throw internalFailure();
    }
    const replayed = BoardOperationResultParserV1.parse({
      ...stored,
      requestId: request.requestId,
      replayed: true,
    });
    if (!replayed.ok) throw internalFailure();
    return replayed.data.value;
  }
}

const asRevisionIdFromBytes = (value: Uint8Array): RevisionId =>
  asRevisionId(formatPublicUuidV4(value));
