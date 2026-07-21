import {
  BoardEventEnvelopeParserV1,
  MutationResultParserV1,
  type MutationRequestV1,
  type MutationResultV1,
} from '@sceneboard/board-schema';
import type { PoolConnection, ResultSetHeader } from 'mysql2/promise';

import { BoardPersistenceError } from '../common/errors/board-persistence.error.js';
import type {
  AuthorizedBoardContextV1,
  BoardAccessPolicy,
  ResolvedBoardPrincipalV1,
} from '../grants/board-access.policy.js';
import { BoardMutationPreparer } from './board-mutation.preparer.js';
import { BoardMutationReplayRepository } from './board-mutation.replay.repository.js';
import { BoardMutationRestoreRepository } from './board-mutation.restore.repository.js';
import {
  actorCode,
  boardArchived,
  digest,
  insertedPk,
  internalFailure,
  invalidMutation,
  isDuplicate,
  isSceneMutation,
  revisionConflict,
  revisionIdFromBytes,
  safePositive,
} from './board-mutation.support.js';
import {
  MutationIdentifierCollisionError,
  type LockedHeadRow,
  type MutationRuntime,
  type PreparedMutationV1,
} from './board-mutation.types.js';
import { SceneCheckpointCodec } from './scene-checkpoint.codec.js';

const MAX_SAFE_SEQUENCE = Number.MAX_SAFE_INTEGER;

export class BoardMutationService {
  private readonly preparer: BoardMutationPreparer;
  private readonly restoreRepository: BoardMutationRestoreRepository;
  private readonly replayRepository = new BoardMutationReplayRepository();

  constructor(
    private readonly accessPolicy: BoardAccessPolicy,
    checkpoints: SceneCheckpointCodec,
    runtime: Partial<MutationRuntime> = {},
  ) {
    this.preparer = new BoardMutationPreparer(checkpoints, runtime);
    this.restoreRepository = new BoardMutationRestoreRepository(checkpoints);
  }

  async applySceneMutation(input: {
    principal: ResolvedBoardPrincipalV1;
    request: MutationRequestV1;
  }): Promise<MutationResultV1> {
    if (!isSceneMutation(input.request.command.type)) throw invalidMutation();
    let prepared = await this.preparer.prepare(input);
    for (let collisionCount = 0; collisionCount <= 3; collisionCount += 1) {
      try {
        return await this.accessPolicy.withAuthorizedBoardTransaction(
          {
            principal: input.principal,
            operation: input.request.command.type,
            boardId: input.request.boardId,
            isolation: 'READ_COMMITTED_WRITE',
          },
          async (connection, context) =>
            this.applyNewOrReplay(connection, context, input.request, prepared),
        );
      } catch (error) {
        if (!(error instanceof MutationIdentifierCollisionError)) throw error;
        if (collisionCount === 3) throw internalFailure();
        prepared = this.preparer.regenerate(prepared, error.kind);
      }
    }
    throw internalFailure();
  }

  private async applyNewOrReplay(
    connection: PoolConnection,
    context: AuthorizedBoardContextV1,
    request: MutationRequestV1,
    prepared: PreparedMutationV1,
  ): Promise<MutationResultV1> {
    const operation = request.command.type;
    if (!isSceneMutation(operation)) throw invalidMutation();
    const [pending] = await connection.execute<ResultSetHeader>(
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
      ],
    );
    if (pending.affectedRows !== 1) {
      return this.replayRepository.replayOrReject(connection, context, request, prepared);
    }
    const recordPk = insertedPk(pending);
    const restore =
      operation === 'scene.restore'
        ? await this.restoreRepository.prepareRestore(connection, request)
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
    const selected =
      restore === null
        ? {
            checkpoint: prepared.checkpoint,
            references: prepared.references,
            sourceRevisionPk: null,
          }
        : await this.restoreRepository.revalidateRestore(connection, head.boardPk, restore);
    if (selected.checkpoint === null || selected.references === null) throw internalFailure();
    const revisionNumber = headNumber + 1;
    const sequence = lastSequence + 1;
    const label =
      operation === 'scene.replace'
        ? 'Updated'
        : operation === 'scene.clear'
          ? 'Cleared'
          : `Restored revision ${restore?.row.revisionNumber ?? ''}`;
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
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
        [
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
        ],
      );
    } catch (error) {
      if (isDuplicate(error, 'uq_revisions_revision_id'))
        throw new MutationIdentifierCollisionError('revision');
      throw error;
    }
    const revisionPk = insertedPk(revisionInsert);
    await this.restoreRepository.insertReferences(connection, revisionPk, selected.references);
    const [headUpdate] = await connection.execute<ResultSetHeader>(
      `
      UPDATE board_heads
      SET head_revision_pk = ?, head_revision_number = ?,
          last_event_sequence = ?, updated_at = ?
      WHERE board_pk = ? AND head_revision_pk = ? AND head_revision_number = ?
    `,
      [
        revisionPk.toString(),
        revisionNumber,
        sequence,
        prepared.occurredAtSql,
        head.boardPk,
        head.headRevisionPk,
        headNumber,
      ],
    );
    if (headUpdate.affectedRows !== 1)
      throw revisionConflict(request, actualRevisionId, headNumber);
    const [boardUpdate] = await connection.execute<ResultSetHeader>(
      `
      UPDATE boards SET updated_at = ? WHERE board_pk = ? AND archived_at IS NULL
    `,
      [prepared.occurredAtSql, head.boardPk],
    );
    if (boardUpdate.affectedRows !== 1) throw internalFailure();
    const revision = {
      revisionId: prepared.revisionId,
      revisionNumber,
      createdAt: prepared.occurredAt,
    };
    const sourceRevisionId =
      operation === 'scene.restore' ? request.command.sourceRevisionId : null;
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
      const [eventInsert] = await connection.execute<ResultSetHeader>(
        `
        INSERT INTO board_event_outbox (
          event_id, board_pk, revision_pk, sequence_number, event_type,
          event_payload, event_canonical_bytes, event_sha256,
          status_code, occurred_at, delivered_at, retain_until
        ) VALUES (?, ?, ?, ?, 'board.revision.created', ?, ?, ?, 'P', ?, NULL, NULL)
      `,
        [
          prepared.eventIdBytes,
          head.boardPk,
          revisionPk.toString(),
          sequence,
          eventPayload,
          eventPayload.byteLength,
          digest(eventPayload),
          prepared.occurredAtSql,
        ],
      );
      insertedPk(eventInsert);
    } catch (error) {
      if (isDuplicate(error, 'uq_outbox_event_id'))
        throw new MutationIdentifierCollisionError('event');
      throw error;
    }
    const result = MutationResultParserV1.parse({
      protocolVersion: 1,
      type: 'mutation.result',
      requestId: request.requestId,
      boardId: request.boardId,
      replayed: false,
      eventIds: [prepared.eventId],
      result:
        operation === 'scene.restore'
          ? { type: operation, sourceRevisionId: request.command.sourceRevisionId, revision }
          : { type: operation, revision },
    });
    if (!result.ok) throw internalFailure();
    const resultPayload = Buffer.from(result.data.canonicalBytes);
    const [complete] = await connection.execute<ResultSetHeader>(
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
        digest(resultPayload),
        head.boardPk,
        revisionPk.toString(),
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
    request: MutationRequestV1,
  ): Promise<LockedHeadRow> {
    const [rows] = await connection.execute<LockedHeadRow[]>(
      `
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
    `,
      [request.boardId],
    );
    const row = rows[0];
    if (rows.length !== 1 || row === undefined) throw internalFailure();
    if (row.archivedAt !== null) throw boardArchived(request, row.archivedAt);
    return row;
  }
}
