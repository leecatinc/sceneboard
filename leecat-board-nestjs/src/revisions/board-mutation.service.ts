import { createHash, timingSafeEqual } from 'node:crypto';

import {
  BoardEventEnvelopeParserV1,
  MutationResultParserV1,
  buildMutationFingerprintV1,
  canonicalizeJsonV1,
  type EventId,
  type MutationRequestV1,
  type MutationResultV1,
  type RevisionId,
  type SceneV1,
  type TimestampV1,
} from '@leecat-board/board-schema';
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
import {
  extractSceneArtifactReferences,
  type SceneArtifactReferenceRowV1,
} from './scene-artifact-reference.extractor.js';
import {
  SceneCheckpointCodec,
  type EncodedSceneCheckpointV1,
} from './scene-checkpoint.codec.js';

type SceneMutationTypeV1 = 'scene.replace' | 'scene.clear' | 'scene.restore';

interface MutationRuntime {
  now(): Date;
  generateUuid(): string;
}

interface PreparedMutationV1 {
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
  checkpoint: EncodedSceneCheckpointV1 | null;
  references: readonly SceneArtifactReferenceRowV1[] | null;
}

interface MutationIdempotencyRow extends RowDataPacket {
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

interface LockedHeadRow extends RowDataPacket {
  boardPk: string;
  archivedAt: string | null;
  headRevisionPk: string;
  headRevisionId: Buffer;
  headRevisionNumber: string;
  lastEventSequence: string;
}

interface RestoreSourceRow extends RowDataPacket {
  revisionPk: string;
  revisionId: Buffer;
  revisionNumber: string;
  sceneSchemaVersion: string;
  sceneCodec: string;
  scenePayload: Buffer;
  sceneCanonicalBytes: number;
  sceneStoredBytes: number;
  sceneSha256: Buffer;
}

interface StoredReferenceRow extends RowDataPacket {
  artifactId: string;
  artifactVersionId: string;
  referenceCode: string;
  occurrenceCount: number;
}

interface ReplayRelationRow extends RowDataPacket {
  boardId: string;
  revisionId: Buffer;
  eventId: Buffer;
}

interface RestorePreparedV1 {
  row: RestoreSourceRow;
  checkpoint: EncodedSceneCheckpointV1;
  references: readonly SceneArtifactReferenceRowV1[];
}

type CollisionKind = 'revision' | 'event' | 'record';

class MutationIdentifierCollisionError extends Error {
  constructor(readonly kind: CollisionKind) {
    super(`mutation identifier collision: ${kind}`);
    this.name = 'MutationIdentifierCollisionError';
  }
}

const MAX_SAFE_SEQUENCE = Number.MAX_SAFE_INTEGER;
const DAY_MS = 24 * 60 * 60 * 1_000;
const digest = (value: Uint8Array): Buffer => createHash('sha256').update(value).digest();
const digestEquals = (left: Uint8Array, right: Uint8Array): boolean => (
  left.byteLength === right.byteLength && timingSafeEqual(Buffer.from(left), Buffer.from(right))
);

const canonicalBytes = (value: unknown): Buffer => {
  const parsed = canonicalizeJsonV1(value);
  if (!parsed.ok) throw internalFailure();
  return Buffer.from(parsed.data.canonicalBytes);
};

const internalFailure = (): BoardContractError => new BoardContractError({
  protocolVersion: 1,
  type: 'board.error',
  code: 'INTERNAL_ERROR',
  message: 'Internal error',
  category: 'internal',
  retryable: false,
  httpStatusHint: 500,
  details: null,
});

const invalidMutation = (): BoardContractError => new BoardContractError({
  protocolVersion: 1,
  type: 'board.error',
  code: 'INVALID_PAYLOAD',
  message: 'Invalid payload',
  category: 'validation',
  retryable: false,
  httpStatusHint: 400,
  details: { path: ['command', 'type'], issue: 'expected a scene mutation' },
});

const revisionNotFound = (revisionId: RevisionId): BoardContractError => new BoardContractError({
  protocolVersion: 1,
  type: 'board.error',
  code: 'REVISION_NOT_FOUND',
  message: 'Revision not found',
  category: 'not_found',
  retryable: false,
  httpStatusHint: 404,
  details: { revisionId },
});

const boardArchived = (request: MutationRequestV1, archivedAt: string): BoardContractError => new BoardContractError({
  protocolVersion: 1,
  type: 'board.error',
  code: 'BOARD_ALREADY_ARCHIVED',
  message: 'Board is already archived',
  category: 'conflict',
  retryable: false,
  httpStatusHint: 409,
  details: { boardId: request.boardId, archivedAt: parseMysqlTimestampUtc(archivedAt).toISOString() as TimestampV1 },
});

const revisionConflict = (
  request: MutationRequestV1,
  actualRevisionId: RevisionId,
  actualRevisionNumber: number,
): BoardContractError => new BoardContractError({
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
): BoardContractError => new BoardContractError({
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

const insertedPk = (result: ResultSetHeader): bigint => {
  if (result.affectedRows !== 1 || !Number.isSafeInteger(result.insertId) || result.insertId < 1) {
    throw internalFailure();
  }
  return BigInt(result.insertId);
};

const actorCode = (kind: AuthorizedBoardContextV1['actor']['principalKind']): 'U' | 'M' | 'S' => {
  if (kind === 'user') return 'U';
  if (kind === 'mcp_client') return 'M';
  return 'S';
};

const safePositive = (value: string): number => {
  if (!/^[1-9][0-9]{0,15}$/.test(value)) throw new BoardPersistenceError('row_integrity');
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new BoardPersistenceError('row_integrity');
  return parsed;
};

const uuidBytesOrNull = (value: string): Buffer | null => {
  try {
    return Buffer.from(parsePublicUuidV4(value));
  } catch {
    return null;
  }
};

const revisionIdFromBytes = (value: Uint8Array): RevisionId => formatPublicUuidV4(value) as RevisionId;
const eventIdFromBytes = (value: Uint8Array): EventId => formatPublicUuidV4(value) as EventId;

const isDuplicate = (error: unknown, constraint: string): boolean => {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { errno?: unknown; code?: unknown; sqlMessage?: unknown; message?: unknown };
  if (candidate.errno !== 1062 && candidate.code !== 'ER_DUP_ENTRY') return false;
  return `${candidate.sqlMessage ?? candidate.message ?? ''}`.includes(constraint);
};

const referenceRowsEqual = (
  left: readonly SceneArtifactReferenceRowV1[],
  right: readonly SceneArtifactReferenceRowV1[],
): boolean => JSON.stringify(left) === JSON.stringify(right);

export class BoardMutationService {
  private readonly runtime: MutationRuntime;

  constructor(
    private readonly accessPolicy: BoardAccessPolicy,
    private readonly checkpoints: SceneCheckpointCodec,
    runtime: Partial<MutationRuntime> = {},
  ) {
    this.runtime = {
      now: runtime.now ?? (() => new Date()),
      generateUuid: runtime.generateUuid ?? (() => generatePublicUuidV4()),
    };
  }

  async applySceneMutation(input: {
    principal: ResolvedBoardPrincipalV1;
    request: MutationRequestV1;
  }): Promise<MutationResultV1> {
    if (!this.isSceneMutation(input.request.command.type)) throw invalidMutation();
    let prepared = await this.prepare(input);
    for (let collisionCount = 0; collisionCount <= 3; collisionCount += 1) {
      try {
        return await this.accessPolicy.withAuthorizedBoardTransaction({
          principal: input.principal,
          operation: input.request.command.type,
          boardId: input.request.boardId,
          isolation: 'READ_COMMITTED_WRITE',
        }, async (connection, context) => this.applyNewOrReplay(connection, context, input.request, prepared));
      } catch (error) {
        if (!(error instanceof MutationIdentifierCollisionError)) throw error;
        if (collisionCount === 3) throw internalFailure();
        prepared = this.regenerate(prepared, error.kind);
      }
    }
    throw internalFailure();
  }

  private isSceneMutation(value: string): value is SceneMutationTypeV1 {
    return value === 'scene.replace' || value === 'scene.clear' || value === 'scene.restore';
  }

  private async prepare(input: {
    principal: ResolvedBoardPrincipalV1;
    request: MutationRequestV1;
  }): Promise<PreparedMutationV1> {
    const fingerprint = buildMutationFingerprintV1({
      ...input.request,
      actor: input.principal.actor,
    });
    if (!fingerprint.ok) throw new BoardContractError(fingerprint.error);
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
    const now = this.runtime.now();
    if (!Number.isFinite(now.valueOf())) throw internalFailure();
    const expiresAt = new Date(now.valueOf() + 30 * DAY_MS);
    const revisionUuid = this.runtime.generateUuid();
    const eventUuid = this.runtime.generateUuid();
    const recordUuid = this.runtime.generateUuid();
    let scene: SceneV1 | null = null;
    if (input.request.command.type === 'scene.replace') scene = input.request.command.scene;
    else if (input.request.command.type === 'scene.clear') {
      scene = { protocolVersion: 1, type: 'scene', root: null };
    }
    const checkpoint = scene === null ? null : await this.checkpoints.encode(scene);
    return {
      revisionId: revisionUuid as RevisionId,
      revisionIdBytes: Buffer.from(parsePublicUuidV4(revisionUuid)),
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
      checkpoint,
      references: scene === null ? null : extractSceneArtifactReferences(scene),
    };
  }

  private regenerate(prepared: PreparedMutationV1, kind: CollisionKind): PreparedMutationV1 {
    const uuid = this.runtime.generateUuid();
    const bytes = Buffer.from(parsePublicUuidV4(uuid));
    if (kind === 'revision') return { ...prepared, revisionId: uuid as RevisionId, revisionIdBytes: bytes };
    if (kind === 'event') return { ...prepared, eventId: uuid as EventId, eventIdBytes: bytes };
    return { ...prepared, recordIdBytes: bytes };
  }

  private async applyNewOrReplay(
    connection: PoolConnection,
    context: AuthorizedBoardContextV1,
    request: MutationRequestV1,
    prepared: PreparedMutationV1,
  ): Promise<MutationResultV1> {
    const operation = request.command.type;
    if (!this.isSceneMutation(operation)) throw invalidMutation();
    const [pending] = await connection.execute<ResultSetHeader>(`
      INSERT INTO board_idempotency_records (
        record_id, scope_code, principal_kind, principal_id, scope_subject,
        idempotency_key, operation_type, fingerprint_version, fingerprint_payload,
        fingerprint_canonical_bytes, fingerprint_sha256, actor_grant_id,
        actor_scopes_payload, actor_scopes_sha256, expected_revision_id,
        command_payload_sha256, initial_request_id, status_code, created_at
      ) VALUES (?, 'M', ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'P', ?)
      ON DUPLICATE KEY UPDATE record_pk = LAST_INSERT_ID(record_pk)
    `, [
      prepared.recordIdBytes,
      actorCode(context.actor.principalKind),
      context.actor.principalId,
      request.boardId,
      request.idempotencyKey,
      operation,
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
    ]);
    if (pending.affectedRows !== 1) {
      return this.replayOrReject(connection, context, request, prepared);
    }
    const recordPk = insertedPk(pending);
    const restore = operation === 'scene.restore'
      ? await this.prepareRestore(connection, request)
      : null;
    const head = await this.lockHead(connection, request);
    const actualRevisionId = revisionIdFromBytes(head.headRevisionId);
    const headNumber = safePositive(head.headRevisionNumber);
    const lastSequence = safePositive(head.lastEventSequence);
    if (actualRevisionId !== request.expectedRevisionId) {
      throw revisionConflict(request, actualRevisionId, headNumber);
    }
    if (headNumber >= MAX_SAFE_SEQUENCE || lastSequence >= MAX_SAFE_SEQUENCE) {
      throw new BoardPersistenceError('capacity_exhausted');
    }
    const selected = restore === null
      ? { checkpoint: prepared.checkpoint, references: prepared.references, sourceRevisionPk: null }
      : await this.revalidateRestore(connection, head.boardPk, restore);
    if (selected.checkpoint === null || selected.references === null) throw internalFailure();
    const revisionNumber = headNumber + 1;
    const sequence = lastSequence + 1;
    const label = operation === 'scene.replace'
      ? 'Updated'
      : operation === 'scene.clear'
        ? 'Cleared'
        : `Restored revision ${restore?.row.revisionNumber ?? ''}`;
    let revisionInsert: ResultSetHeader;
    try {
      [revisionInsert] = await connection.execute<ResultSetHeader>(`
        INSERT INTO board_revisions (
          revision_id, board_pk, revision_number, previous_revision_pk, source_revision_pk,
          origin_code, label, scene_schema_version, scene_codec, scene_payload,
          scene_canonical_bytes, scene_stored_bytes, scene_sha256,
          actor_kind, actor_principal_id, actor_grant_id,
          request_id, idempotency_scope_sha256, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        prepared.revisionIdBytes,
        head.boardPk,
        revisionNumber,
        head.headRevisionPk,
        selected.sourceRevisionPk,
        operation === 'scene.replace' ? 'R' : operation === 'scene.clear' ? 'L' : 'S',
        label,
        selected.checkpoint.schemaVersion,
        selected.checkpoint.codec,
        selected.checkpoint.payload,
        selected.checkpoint.canonicalBytes,
        selected.checkpoint.storedBytes,
        selected.checkpoint.sha256,
        actorCode(context.actor.principalKind),
        context.actor.principalId,
        context.actor.grantId,
        request.requestId,
        prepared.idempotencyScopeSha256,
        prepared.occurredAtSql,
      ]);
    } catch (error) {
      if (isDuplicate(error, 'uq_revisions_revision_id')) throw new MutationIdentifierCollisionError('revision');
      throw error;
    }
    const revisionPk = insertedPk(revisionInsert);
    await this.insertReferences(connection, revisionPk, selected.references);
    const [headUpdate] = await connection.execute<ResultSetHeader>(`
      UPDATE board_heads
      SET head_revision_pk = ?, head_revision_number = ?,
          last_event_sequence = ?, updated_at = ?
      WHERE board_pk = ? AND head_revision_pk = ? AND head_revision_number = ?
    `, [
      revisionPk.toString(), revisionNumber, sequence, prepared.occurredAtSql,
      head.boardPk, head.headRevisionPk, headNumber,
    ]);
    if (headUpdate.affectedRows !== 1) throw revisionConflict(request, actualRevisionId, headNumber);
    const [boardUpdate] = await connection.execute<ResultSetHeader>(`
      UPDATE boards SET updated_at = ? WHERE board_pk = ? AND archived_at IS NULL
    `, [prepared.occurredAtSql, head.boardPk]);
    if (boardUpdate.affectedRows !== 1) throw internalFailure();
    const revision = {
      revisionId: prepared.revisionId,
      revisionNumber,
      createdAt: prepared.occurredAt,
    };
    const sourceRevisionId = operation === 'scene.restore'
      ? request.command.sourceRevisionId
      : null;
    const event = BoardEventEnvelopeParserV1.parse({
      protocolVersion: 1,
      type: 'board.event',
      boardId: request.boardId,
      eventId: prepared.eventId,
      sequence,
      occurredAt: prepared.occurredAt,
      revisionId: prepared.revisionId,
      data: {
        type: 'board.revision.created',
        revision,
        originType: operation,
        sourceRevisionId,
      },
    });
    if (!event.ok) throw internalFailure();
    const eventPayload = Buffer.from(event.data.canonicalBytes);
    try {
      const [eventInsert] = await connection.execute<ResultSetHeader>(`
        INSERT INTO board_event_outbox (
          event_id, board_pk, revision_pk, sequence_number, event_type,
          event_payload, event_canonical_bytes, event_sha256,
          status_code, occurred_at, delivered_at, retain_until
        ) VALUES (?, ?, ?, ?, 'board.revision.created', ?, ?, ?, 'P', ?, NULL, NULL)
      `, [
        prepared.eventIdBytes,
        head.boardPk,
        revisionPk.toString(),
        sequence,
        eventPayload,
        eventPayload.byteLength,
        digest(eventPayload),
        prepared.occurredAtSql,
      ]);
      insertedPk(eventInsert);
    } catch (error) {
      if (isDuplicate(error, 'uq_outbox_event_id')) throw new MutationIdentifierCollisionError('event');
      throw error;
    }
    const result = MutationResultParserV1.parse({
      protocolVersion: 1,
      type: 'mutation.result',
      requestId: request.requestId,
      boardId: request.boardId,
      replayed: false,
      eventIds: [prepared.eventId],
      result: operation === 'scene.restore'
        ? { type: operation, sourceRevisionId: request.command.sourceRevisionId, revision }
        : { type: operation, revision },
    });
    if (!result.ok) throw internalFailure();
    const resultPayload = Buffer.from(result.data.canonicalBytes);
    const [complete] = await connection.execute<ResultSetHeader>(`
      UPDATE board_idempotency_records
      SET status_code = 'C',
          result_payload = ?, result_canonical_bytes = ?, result_sha256 = ?,
          result_board_pk = ?, result_revision_pk = ?,
          completed_at = ?, expires_at = ?
      WHERE record_pk = ? AND status_code = 'P'
    `, [
      resultPayload,
      resultPayload.byteLength,
      digest(resultPayload),
      head.boardPk,
      revisionPk.toString(),
      prepared.occurredAtSql,
      prepared.expiresAtSql,
      recordPk.toString(),
    ]);
    if (complete.affectedRows !== 1) throw internalFailure();
    return result.data.value;
  }

  private async lockHead(connection: PoolConnection, request: MutationRequestV1): Promise<LockedHeadRow> {
    const [rows] = await connection.execute<LockedHeadRow[]>(`
      SELECT
        CAST(b.board_pk AS CHAR) AS boardPk,
        b.archived_at AS archivedAt,
        CAST(h.head_revision_pk AS CHAR) AS headRevisionPk,
        hr.revision_id AS headRevisionId,
        CAST(h.head_revision_number AS CHAR) AS headRevisionNumber,
        CAST(h.last_event_sequence AS CHAR) AS lastEventSequence
      FROM boards b
      JOIN board_heads h ON h.board_pk = b.board_pk
      JOIN board_revisions hr
        ON hr.board_pk = h.board_pk
          AND hr.revision_pk = h.head_revision_pk
          AND hr.revision_number = h.head_revision_number
      WHERE b.public_id = ?
      FOR UPDATE
    `, [request.boardId]);
    const row = rows[0];
    if (rows.length !== 1 || row === undefined) throw internalFailure();
    if (row.archivedAt !== null) throw boardArchived(request, row.archivedAt);
    return row;
  }

  private async prepareRestore(
    connection: PoolConnection,
    request: MutationRequestV1,
  ): Promise<RestorePreparedV1> {
    if (request.command.type !== 'scene.restore') throw internalFailure();
    const sourceBytes = uuidBytesOrNull(request.command.sourceRevisionId);
    if (sourceBytes === null) throw revisionNotFound(request.command.sourceRevisionId);
    const [rows] = await connection.execute<RestoreSourceRow[]>(`
      SELECT
        CAST(r.revision_pk AS CHAR) AS revisionPk,
        r.revision_id AS revisionId,
        CAST(r.revision_number AS CHAR) AS revisionNumber,
        r.scene_schema_version AS sceneSchemaVersion,
        r.scene_codec AS sceneCodec,
        r.scene_payload AS scenePayload,
        r.scene_canonical_bytes AS sceneCanonicalBytes,
        r.scene_stored_bytes AS sceneStoredBytes,
        r.scene_sha256 AS sceneSha256
      FROM boards b
      JOIN board_revisions r ON r.board_pk = b.board_pk
      WHERE b.public_id = ? AND r.revision_id = ?
      LIMIT 1
    `, [request.boardId, sourceBytes]);
    const row = rows[0];
    if (rows.length === 0) throw revisionNotFound(request.command.sourceRevisionId);
    if (rows.length !== 1 || row === undefined
      || revisionIdFromBytes(row.revisionId) !== request.command.sourceRevisionId) throw internalFailure();
    safePositive(row.revisionNumber);
    const decoded = await this.checkpoints.decode({
      schemaVersion: row.sceneSchemaVersion as '1.0.0',
      codec: row.sceneCodec as 'B',
      payload: row.scenePayload,
      canonicalBytes: row.sceneCanonicalBytes,
      storedBytes: row.sceneStoredBytes,
      sha256: row.sceneSha256,
    });
    const references = await this.readReferences(connection, row.revisionPk);
    if (!referenceRowsEqual(references, extractSceneArtifactReferences(decoded.scene))) {
      throw new BoardPersistenceError('row_integrity');
    }
    return {
      row,
      checkpoint: {
        schemaVersion: '1.0.0',
        codec: 'B',
        payload: Buffer.from(row.scenePayload),
        canonicalPayload: Buffer.from(decoded.canonicalBytes),
        canonicalBytes: row.sceneCanonicalBytes,
        storedBytes: row.sceneStoredBytes,
        sha256: Buffer.from(row.sceneSha256),
      },
      references,
    };
  }

  private async revalidateRestore(
    connection: PoolConnection,
    boardPk: string,
    prepared: RestorePreparedV1,
  ): Promise<{
    checkpoint: EncodedSceneCheckpointV1;
    references: readonly SceneArtifactReferenceRowV1[];
    sourceRevisionPk: string;
  }> {
    const [rows] = await connection.execute<RestoreSourceRow[]>(`
      SELECT
        CAST(revision_pk AS CHAR) AS revisionPk,
        revision_id AS revisionId,
        CAST(revision_number AS CHAR) AS revisionNumber,
        scene_schema_version AS sceneSchemaVersion,
        scene_codec AS sceneCodec,
        scene_payload AS scenePayload,
        scene_canonical_bytes AS sceneCanonicalBytes,
        scene_stored_bytes AS sceneStoredBytes,
        scene_sha256 AS sceneSha256
      FROM board_revisions
      WHERE board_pk = ? AND revision_pk = ?
      LIMIT 1
    `, [boardPk, prepared.row.revisionPk]);
    const row = rows[0];
    if (rows.length !== 1 || row === undefined
      || row.revisionPk !== prepared.row.revisionPk
      || !row.revisionId.equals(prepared.row.revisionId)
      || row.revisionNumber !== prepared.row.revisionNumber
      || row.sceneSchemaVersion !== prepared.row.sceneSchemaVersion
      || row.sceneCodec !== prepared.row.sceneCodec
      || row.sceneCanonicalBytes !== prepared.row.sceneCanonicalBytes
      || row.sceneStoredBytes !== prepared.row.sceneStoredBytes
      || !row.sceneSha256.equals(prepared.row.sceneSha256)
      || !row.scenePayload.equals(prepared.row.scenePayload)) {
      throw new BoardPersistenceError('row_integrity');
    }
    const references = await this.readReferences(connection, row.revisionPk);
    if (!referenceRowsEqual(references, prepared.references)) throw new BoardPersistenceError('row_integrity');
    return {
      checkpoint: prepared.checkpoint,
      references,
      sourceRevisionPk: row.revisionPk,
    };
  }

  private async readReferences(
    connection: PoolConnection,
    revisionPk: string,
  ): Promise<SceneArtifactReferenceRowV1[]> {
    const [rows] = await connection.execute<StoredReferenceRow[]>(`
      SELECT artifact_id AS artifactId, artifact_version_id AS artifactVersionId,
             reference_code AS referenceCode, occurrence_count AS occurrenceCount
      FROM board_revision_artifact_refs
      WHERE revision_pk = ?
      ORDER BY artifact_id, artifact_version_id, reference_code
    `, [revisionPk]);
    return rows.map((row) => {
      if ((row.referenceCode !== 'A' && row.referenceCode !== 'I')
        || !Number.isSafeInteger(row.occurrenceCount)
        || row.occurrenceCount < 1 || row.occurrenceCount > 500) {
        throw new BoardPersistenceError('row_integrity');
      }
      return {
        artifactId: row.artifactId,
        artifactVersionId: row.artifactVersionId,
        referenceCode: row.referenceCode,
        occurrenceCount: row.occurrenceCount,
      };
    });
  }

  private async insertReferences(
    connection: PoolConnection,
    revisionPk: bigint,
    references: readonly SceneArtifactReferenceRowV1[],
  ): Promise<void> {
    if (references.length === 0) return;
    const placeholders = references.map(() => '(?, ?, ?, ?, ?)').join(', ');
    const binds = references.flatMap((reference) => [
      revisionPk.toString(),
      reference.artifactId,
      reference.artifactVersionId,
      reference.referenceCode,
      reference.occurrenceCount,
    ]);
    const [insert] = await connection.execute<ResultSetHeader>(`
      INSERT INTO board_revision_artifact_refs (
        revision_pk, artifact_id, artifact_version_id, reference_code, occurrence_count
      ) VALUES ${placeholders}
    `, binds);
    if (insert.affectedRows !== references.length) throw internalFailure();
  }

  private async replayOrReject(
    connection: PoolConnection,
    context: AuthorizedBoardContextV1,
    request: MutationRequestV1,
    prepared: PreparedMutationV1,
  ): Promise<MutationResultV1> {
    const [rows] = await connection.execute<MutationIdempotencyRow[]>(`
      SELECT status_code AS statusCode, operation_type AS operationType,
             fingerprint_sha256 AS fingerprintSha256,
             actor_grant_id AS actorGrantId, actor_scopes_sha256 AS actorScopesSha256,
             expected_revision_id AS expectedRevisionId,
             command_payload_sha256 AS commandPayloadSha256,
             result_payload AS resultPayload,
             result_canonical_bytes AS resultCanonicalBytes,
             result_sha256 AS resultSha256,
             CAST(result_board_pk AS CHAR) AS resultBoardPk,
             CAST(result_revision_pk AS CHAR) AS resultRevisionPk
      FROM board_idempotency_records
      WHERE scope_code = 'M' AND principal_kind = ? AND principal_id = ?
        AND scope_subject = ? AND idempotency_key = ?
      FOR UPDATE
    `, [
      actorCode(context.actor.principalKind), context.actor.principalId,
      request.boardId, request.idempotencyKey,
    ]);
    const row = rows[0];
    if (rows.length === 0) throw new MutationIdentifierCollisionError('record');
    if (rows.length !== 1 || row === undefined) throw internalFailure();
    if (!digestEquals(row.fingerprintSha256, prepared.fingerprintSha256)) {
      if (row.actorGrantId !== context.actor.grantId) throw idempotencyReuse(request, 'grant_changed');
      if (!digestEquals(row.actorScopesSha256, prepared.actorScopesSha256)) {
        throw idempotencyReuse(request, 'scopes_changed');
      }
      if (row.expectedRevisionId !== request.expectedRevisionId) {
        throw idempotencyReuse(request, 'expected_revision_changed');
      }
      if (!digestEquals(row.commandPayloadSha256, prepared.commandPayloadSha256)
        || row.operationType !== request.command.type) {
        throw idempotencyReuse(request, 'payload_changed');
      }
      throw internalFailure();
    }
    if (row.operationType !== request.command.type
      || row.statusCode !== 'C' || row.resultPayload === null
      || row.resultCanonicalBytes === null || row.resultSha256 === null
      || row.resultBoardPk === null || row.resultRevisionPk === null
      || row.resultCanonicalBytes !== row.resultPayload.byteLength
      || row.resultPayload.byteLength < 1 || row.resultPayload.byteLength > 1_048_576
      || !digestEquals(digest(row.resultPayload), row.resultSha256)) {
      throw internalFailure();
    }
    const stored = MutationResultParserV1.parseBytes(row.resultPayload);
    if (!stored.ok || !Buffer.from(stored.data.canonicalBytes).equals(row.resultPayload)
      || stored.data.value.replayed || stored.data.value.boardId !== request.boardId
      || stored.data.value.result.type !== request.command.type
      || stored.data.value.eventIds.length !== 1) {
      throw internalFailure();
    }
    const resultRevisionId = stored.data.value.result.type === 'scene.restore'
      || stored.data.value.result.type === 'scene.replace'
      || stored.data.value.result.type === 'scene.clear'
      ? stored.data.value.result.revision.revisionId
      : null;
    if (resultRevisionId === null) throw internalFailure();
    const [relations] = await connection.execute<ReplayRelationRow[]>(`
      SELECT b.public_id AS boardId, r.revision_id AS revisionId, e.event_id AS eventId
      FROM boards b
      JOIN board_revisions r
        ON r.board_pk = b.board_pk AND r.revision_pk = ?
      JOIN board_event_outbox e
        ON e.board_pk = b.board_pk AND e.revision_pk = r.revision_pk
          AND e.event_type = 'board.revision.created'
      WHERE b.board_pk = ?
      LIMIT 1
    `, [row.resultRevisionPk, row.resultBoardPk]);
    const relation = relations[0];
    if (relations.length !== 1 || relation === undefined
      || relation.boardId !== request.boardId
      || revisionIdFromBytes(relation.revisionId) !== resultRevisionId
      || eventIdFromBytes(relation.eventId) !== stored.data.value.eventIds[0]) {
      throw internalFailure();
    }
    const replay = MutationResultParserV1.parse({
      ...stored.data.value,
      requestId: request.requestId,
      replayed: true,
    });
    if (!replay.ok) throw internalFailure();
    return replay.data.value;
  }
}
