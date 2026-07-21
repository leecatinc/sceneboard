import {
  MutationResultParserV1,
  type MutationRequestV1,
  type MutationResultV1,
} from '@sceneboard/board-schema';
import type { PoolConnection } from 'mysql2/promise';

import type { AuthorizedBoardContextV1 } from '../grants/board-access.policy.js';
import {
  actorCode,
  digest,
  digestEquals,
  eventIdFromBytes,
  idempotencyReuse,
  internalFailure,
  revisionIdFromBytes,
} from './board-mutation.support.js';
import {
  MutationIdentifierCollisionError,
  type MutationIdempotencyRow,
  type PreparedMutationV1,
  type ReplayRelationRow,
} from './board-mutation.types.js';

export class BoardMutationReplayRepository {
  async replayOrReject(
    connection: PoolConnection,
    context: AuthorizedBoardContextV1,
    request: MutationRequestV1,
    prepared: PreparedMutationV1,
  ): Promise<MutationResultV1> {
    const [rows] = await connection.execute<MutationIdempotencyRow[]>(
      `
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
    `,
      [
        actorCode(context.actor.principalKind),
        context.actor.principalId,
        request.boardId,
        request.idempotencyKey,
      ],
    );
    const row = rows[0];
    if (rows.length === 0) throw new MutationIdentifierCollisionError('record');
    if (rows.length !== 1 || row === undefined) throw internalFailure();
    if (!digestEquals(row.fingerprintSha256, prepared.fingerprintSha256)) {
      if (row.actorGrantId !== context.actor.grantId) {
        throw idempotencyReuse(request, 'grant_changed');
      }
      if (!digestEquals(row.actorScopesSha256, prepared.actorScopesSha256)) {
        throw idempotencyReuse(request, 'scopes_changed');
      }
      if (row.expectedRevisionId !== request.expectedRevisionId) {
        throw idempotencyReuse(request, 'expected_revision_changed');
      }
      if (
        !digestEquals(row.commandPayloadSha256, prepared.commandPayloadSha256) ||
        row.operationType !== request.command.type
      ) {
        throw idempotencyReuse(request, 'payload_changed');
      }
      throw internalFailure();
    }
    if (
      row.operationType !== request.command.type ||
      row.statusCode !== 'C' ||
      row.resultPayload === null ||
      row.resultCanonicalBytes === null ||
      row.resultSha256 === null ||
      row.resultBoardPk === null ||
      row.resultRevisionPk === null ||
      row.resultCanonicalBytes !== row.resultPayload.byteLength ||
      row.resultPayload.byteLength < 1 ||
      row.resultPayload.byteLength > 1_048_576 ||
      !digestEquals(digest(row.resultPayload), row.resultSha256)
    ) {
      throw internalFailure();
    }
    const stored = MutationResultParserV1.parseBytes(row.resultPayload);
    if (
      !stored.ok ||
      !Buffer.from(stored.data.canonicalBytes).equals(row.resultPayload) ||
      stored.data.value.replayed ||
      stored.data.value.boardId !== request.boardId ||
      stored.data.value.result.type !== request.command.type ||
      stored.data.value.eventIds.length !== 1
    ) {
      throw internalFailure();
    }
    const resultRevisionId =
      stored.data.value.result.type === 'scene.restore' ||
      stored.data.value.result.type === 'scene.replace' ||
      stored.data.value.result.type === 'scene.clear'
        ? stored.data.value.result.revision.revisionId
        : null;
    if (resultRevisionId === null) throw internalFailure();
    const [relations] = await connection.execute<ReplayRelationRow[]>(
      `
      SELECT b.public_id AS boardId, r.revision_id AS revisionId, e.event_id AS eventId
      FROM boards b
      JOIN board_revisions r
        ON r.board_pk = b.board_pk AND r.revision_pk = ?
      JOIN board_event_outbox e
        ON e.board_pk = b.board_pk AND e.revision_pk = r.revision_pk
          AND e.event_type = 'board.revision.created'
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
      revisionIdFromBytes(relation.revisionId) !== resultRevisionId ||
      eventIdFromBytes(relation.eventId) !== stored.data.value.eventIds[0]
    ) {
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
