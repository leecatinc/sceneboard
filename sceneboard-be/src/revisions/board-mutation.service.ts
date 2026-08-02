import {
  BoardEventEnvelopeParserV2,
  BoardEventEnvelopeParserV3,
  MutationResultParserV1,
  MutationResultParserV2,
  MutationResultParserV3,
  type MutationRequestV1,
  type MutationRequestV2,
  type MutationRequestV3,
  type MutationResultV1,
  type MutationResultV2,
  type MutationResultV3,
} from '@sceneboard/board-schema';
import type { PoolConnection, ResultSetHeader } from 'mysql2/promise';

import { BoardContractError } from '../common/errors/app-error.js';
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
  documentVersionMismatch,
  effectiveCheckpointFromLockedHead,
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
  type CheckpointMutationRequest,
  type CheckpointMutationResult,
  type LockedHeadRow,
  type MutationRuntime,
  type PreparedMutationV1,
} from './board-mutation.types.js';
import { DocumentCheckpointCodec } from './document-checkpoint.codec.js';
import { RevisionPayloadCatalogRepository } from './revision-payload-catalog.repository.js';
import { DenyAllMediaOwnershipProvider } from '../media/deny-all-media-ownership.provider.js';
import type { MediaOwnershipPort } from '../media/media-ownership.port.js';
import { RevisionMediaReferenceExtractor } from '../media/revision-media-reference.extractor.js';

const MAX_SAFE_SEQUENCE = Number.MAX_SAFE_INTEGER;

export class BoardMutationService {
  private readonly preparer: BoardMutationPreparer;
  private readonly restoreRepository: BoardMutationRestoreRepository;
  private readonly replayRepository = new BoardMutationReplayRepository();
  private readonly payloadCatalog = new RevisionPayloadCatalogRepository();

  constructor(
    private readonly accessPolicy: BoardAccessPolicy,
    private readonly checkpoints: DocumentCheckpointCodec,
    runtime: Partial<MutationRuntime> = {},
    private readonly mediaOwnership: MediaOwnershipPort = new DenyAllMediaOwnershipProvider(),
    mediaReferences = new RevisionMediaReferenceExtractor(),
    private readonly v3WriteEnabled = false,
  ) {
    this.preparer = new BoardMutationPreparer(checkpoints, runtime, mediaReferences);
    this.restoreRepository = new BoardMutationRestoreRepository(checkpoints, mediaReferences);
  }

  async applySceneMutation(input: {
    principal: ResolvedBoardPrincipalV1;
    request: MutationRequestV1 | MutationRequestV3;
    documentSchemaVersion?: 1 | 2 | 3;
  }): Promise<MutationResultV1 | MutationResultV2 | MutationResultV3> {
    const documentSchemaVersion = input.documentSchemaVersion ?? 1;
    const result = await this.applyCheckpointMutation({ ...input, documentSchemaVersion });
    if (documentSchemaVersion !== 1) return result;
    const parsed = MutationResultParserV1.parse(result);
    if (!parsed.ok) throw internalFailure();
    return parsed.data.value;
  }

  async applyDocumentMutation(input: {
    principal: ResolvedBoardPrincipalV1;
    request: MutationRequestV2 | MutationRequestV3;
  }): Promise<MutationResultV2 | MutationResultV3> {
    if (input.request.command.type !== 'document.replace') throw invalidMutation();
    const documentSchemaVersion = input.request.command.document.schemaVersion;
    return this.applyCheckpointMutation({
      ...input,
      documentSchemaVersion,
    }) as Promise<MutationResultV2 | MutationResultV3>;
  }

  private assertV3WriteEnabled(): void {
    if (this.v3WriteEnabled) return;
    throw new BoardContractError({
      protocolVersion: 1,
      type: 'board.error',
      code: 'SERVICE_UNAVAILABLE',
      message: 'Document V3 writing is disabled',
      category: 'availability',
      retryable: true,
      httpStatusHint: 503,
      details: { retryAfterSeconds: null },
    });
  }

  private async applyCheckpointMutation(input: {
    principal: ResolvedBoardPrincipalV1;
    request: CheckpointMutationRequest;
    documentSchemaVersion: 1 | 2 | 3;
  }): Promise<CheckpointMutationResult> {
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
            this.applyNewOrReplay(
              connection,
              context,
              input.request,
              prepared,
              input.documentSchemaVersion,
            ),
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
    request: CheckpointMutationRequest,
    prepared: PreparedMutationV1,
    documentSchemaVersion: 1 | 2 | 3,
  ): Promise<CheckpointMutationResult> {
    const operation = request.command.type;
    if (!isSceneMutation(operation)) throw invalidMutation();
    const head = await this.lockHead(connection, request);
    const actualRevisionId = revisionIdFromBytes(head.headRevisionId);
    const headNumber = safePositive(head.headRevisionNumber);
    const lastSequence = safePositive(head.lastEventSequence);
    const effectiveHeadCheckpoint = effectiveCheckpointFromLockedHead(head);
    const decodedHead = await this.checkpoints.decode(effectiveHeadCheckpoint);
    const headSchemaVersion = decodedHead.kind === 'scene' ? 1 : decodedHead.document.schemaVersion;
    const replay = await this.replayRepository.replayOrReject(
      connection,
      context,
      request,
      prepared,
      'return-null',
    );
    if (replay !== null) {
      if (!('revision' in replay.result)) throw internalFailure();
      const replayState = await this.restoreRepository.assertReplayRevisionIntegrity(
        connection,
        request.boardId,
        replay.result.revision.revisionId,
      );
      await this.mediaOwnership.assertOwnedByBoard(
        connection,
        replayState.boardPk,
        replayState.mediaReferences.map((reference) => reference.mediaId),
      );
      return replay;
    }
    if (headSchemaVersion === 3 && documentSchemaVersion !== 3) {
      throw new BoardContractError({
        protocolVersion: 1,
        type: 'board.error',
        code: 'UPGRADE_REQUIRED',
        message: 'A newer document client is required',
        category: 'conflict',
        retryable: false,
        httpStatusHint: 409,
        details: {
          headSchemaVersion: 3,
          requestedDocumentSchemaVersion: documentSchemaVersion,
          operationType: operation,
        },
      });
    }
    if (documentSchemaVersion === 3) this.assertV3WriteEnabled();
    if (actualRevisionId !== request.expectedRevisionId) {
      throw revisionConflict(request, actualRevisionId, headNumber);
    }
    if (headSchemaVersion === 2 && (operation === 'scene.replace' || operation === 'scene.clear')) {
      throw documentVersionMismatch(2, 1, operation);
    }
    if (headNumber >= MAX_SAFE_SEQUENCE || lastSequence >= MAX_SAFE_SEQUENCE) {
      throw new BoardPersistenceError('capacity_exhausted');
    }
    const restore =
      operation === 'scene.restore'
        ? await this.restoreRepository.prepareRestore(connection, request)
        : null;
    const selected =
      restore === null
        ? {
            checkpoint: prepared.checkpoint,
            references: prepared.references,
            mediaReferences: prepared.mediaReferences,
            sourceRevisionPk: null,
          }
        : await this.restoreRepository.revalidateRestore(
            connection,
            head.boardPk,
            restore,
            effectiveHeadCheckpoint.schemaVersion,
            request.boardId,
            prepared.revisionId,
            documentSchemaVersion,
          );
    if (
      selected.checkpoint === null ||
      selected.references === null ||
      selected.mediaReferences === null
    )
      throw internalFailure();
    await this.mediaOwnership.assertOwnedByBoard(
      connection,
      BigInt(head.boardPk),
      selected.mediaReferences.map((reference) => reference.mediaId),
    );
    const revisionNumber = headNumber + 1;
    const sequence = lastSequence + 1;
    const revision = {
      revisionId: prepared.revisionId,
      revisionNumber,
      createdAt: prepared.occurredAt,
    };
    const sourceRevisionId =
      operation === 'scene.restore' ? request.command.sourceRevisionId : null;
    const eventParser =
      documentSchemaVersion === 3 ? BoardEventEnvelopeParserV3 : BoardEventEnvelopeParserV2;
    const event = eventParser.parse({
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
    if (!event.ok) throw new BoardContractError(event.error);
    const eventPayload = Buffer.from(event.data.canonicalBytes);
    const resultParser =
      documentSchemaVersion === 3 ? MutationResultParserV3 : MutationResultParserV2;
    const result = resultParser.parse({
      protocolVersion: 1,
      type: 'mutation.result',
      requestId: request.requestId,
      boardId: request.boardId,
      replayed: false,
      eventIds: [prepared.eventId],
      result:
        operation === 'scene.restore'
          ? { type: operation, sourceRevisionId: request.command.sourceRevisionId, revision }
          : operation === 'document.replace'
            ? {
                type: operation,
                revision,
                originType: operation,
                sourceRevisionId: null,
                document: request.command.document,
              }
            : { type: operation, revision },
    });
    if (!result.ok) throw new BoardContractError(result.error);
    const resultPayload = Buffer.from(result.data.canonicalBytes);
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
      const raced = await this.replayRepository.replayOrReject(
        connection,
        context,
        request,
        prepared,
      );
      if (raced === null) throw internalFailure();
      if (!('revision' in raced.result)) throw internalFailure();
      const replayState = await this.restoreRepository.assertReplayRevisionIntegrity(
        connection,
        request.boardId,
        raced.result.revision.revisionId,
      );
      await this.mediaOwnership.assertOwnedByBoard(
        connection,
        replayState.boardPk,
        replayState.mediaReferences.map((reference) => reference.mediaId),
      );
      return raced;
    }
    const recordPk = insertedPk(pending);
    const label =
      operation === 'scene.replace'
        ? 'Updated'
        : operation === 'scene.clear'
          ? 'Cleared'
          : operation === 'document.replace'
            ? 'Updated document'
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
          operation === 'scene.replace'
            ? 'R'
            : operation === 'scene.clear'
              ? 'L'
              : operation === 'document.replace'
                ? 'D'
                : 'S',
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
    await this.payloadCatalog.persistRevisionBundle(connection, {
      boardPk: head.boardPk,
      revisionPk: revisionPk.toString(),
      retainedOrder: revisionNumber,
      createdAtSql: prepared.occurredAtSql,
      actorAccountPk:
        context.access.kind === 'api_key'
          ? (context.accountUserPk ?? context.ownerUserPk).toString()
          : context.membership !== undefined
            ? (context.accountUserPk ?? context.ownerUserPk).toString()
            : context.access.kind === 'owner' && context.actor.principalKind === 'user'
              ? context.ownerUserPk.toString()
              : null,
      actorClass:
        context.access.kind === 'api_key'
          ? 'owner'
          : context.actor.principalKind === 'service'
            ? 'system'
            : context.membership !== undefined
              ? context.membership?.membershipRole === 'owner'
                ? 'owner'
                : 'editor'
              : context.access.kind === 'owner'
                ? 'owner'
                : 'editor',
      checkpoint: selected.checkpoint,
    });
    await this.restoreRepository.insertReferences(connection, revisionPk, selected.references);
    await this.restoreRepository.insertMediaReferences(connection, {
      boardPk: BigInt(head.boardPk),
      revisionPk,
      references: selected.mediaReferences,
    });
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
    request: CheckpointMutationRequest,
  ): Promise<LockedHeadRow> {
    const [rows] = await connection.execute<LockedHeadRow[]>(
      `
      SELECT
        CAST(b.board_pk AS CHAR) AS boardPk,
        b.archived_at AS archivedAt,
        CAST(h.head_revision_pk AS CHAR) AS headRevisionPk,
        hr.revision_id AS headRevisionId,
        CAST(h.head_revision_number AS CHAR) AS headRevisionNumber,
        CAST(h.last_event_sequence AS CHAR) AS lastEventSequence,
        CASE WHEN p.revision_pk IS NOT NULL
          THEN p.schema_version ELSE hr.scene_schema_version END AS sceneSchemaVersion,
        CASE WHEN p.revision_pk IS NOT NULL
          THEN p.codec ELSE hr.scene_codec END AS sceneCodec,
        CASE WHEN p.revision_pk IS NOT NULL
          THEN p.payload ELSE hr.scene_payload END AS scenePayload,
        CASE WHEN p.revision_pk IS NOT NULL
          THEN p.canonical_bytes ELSE hr.scene_canonical_bytes END AS sceneCanonicalBytes,
        CASE WHEN p.revision_pk IS NOT NULL
          THEN p.stored_bytes ELSE hr.scene_stored_bytes END AS sceneStoredBytes,
        CASE WHEN p.revision_pk IS NOT NULL
          THEN p.payload_sha256 ELSE hr.scene_sha256 END AS sceneSha256
      FROM boards b
      JOIN board_heads h ON h.board_pk = b.board_pk
      JOIN board_revisions hr
        ON hr.board_pk = h.board_pk
          AND hr.revision_pk = h.head_revision_pk
          AND hr.revision_number = h.head_revision_number
      LEFT JOIN board_revision_payloads p
        ON p.revision_pk = hr.revision_pk AND p.state = 'available'
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
