import {
  BoardOperationRequestParserV1,
  BoardOperationResultParserV1,
  type BoardOperationResultV1,
  type HitlInteractionV1,
  type TimestampV1,
} from '@sceneboard/board-schema';
import type { PoolConnection, RowDataPacket } from 'mysql2/promise';

import { BoardContractError } from '../../common/errors/app-error.js';
import type {
  AuthorizedBoardContextV1,
  BoardAccessPolicy,
  ResolvedBoardPrincipalV1,
} from '../../grants/board-access.policy.js';
import { DocumentCheckpointCodec } from '../../revisions/document-checkpoint.codec.js';
import {
  extractUniqueDocumentHitlRequestIds,
  extractUniqueSceneHitlRequestIds,
} from '../../revisions/scene-hitl-reference.extractor.js';
import { InteractionRepository } from '../persistence/interaction.repository.js';
import type { StoredInteractionV1 } from '../persistence/interaction-row.mapper.js';
import {
  HitlQueryApplicationPortV1,
  type HitlReadOperationRequestV1,
} from './hitl-query-application.port.js';
import { HitlExpiryService } from './hitl-expiry.service.js';
import { hitlNotFound, internalHitlFailure } from './hitl-errors.js';
import { HitlWaitCoordinator } from './hitl-wait-coordinator.js';

interface CurrentHeadCheckpointRow extends RowDataPacket {
  schemaVersion: string | null;
  codec: string | null;
  payload: Buffer | null;
  canonicalBytes: number | null;
  storedBytes: number | null;
  sha256: Buffer | null;
}

const boardNotFound = (): BoardContractError =>
  new BoardContractError({
    protocolVersion: 1,
    type: 'board.error',
    code: 'BOARD_NOT_FOUND',
    message: 'Board not found',
    category: 'not_found',
    retryable: false,
    httpStatusHint: 404,
    details: null,
  });

const result = (
  request: HitlReadOperationRequestV1,
  interaction: HitlInteractionV1,
  changed: boolean,
): BoardOperationResultV1 => {
  const parsed = BoardOperationResultParserV1.parse({
    protocolVersion: 1,
    type: 'board.operation.result',
    requestId: request.requestId,
    replayed: false,
    result: { type: 'hitl.read', changed, hitl: interaction },
  });
  if (!parsed.ok) throw internalHitlFailure();
  return parsed.data.value;
};

export class InteractionQueryService extends HitlQueryApplicationPortV1 {
  constructor(
    private readonly accessPolicy: BoardAccessPolicy,
    private readonly interactions: InteractionRepository,
    private readonly expiry: HitlExpiryService,
    private readonly waits: HitlWaitCoordinator,
    private readonly clock: () => number = () => Date.now(),
    private readonly checkpoints: DocumentCheckpointCodec | null = null,
  ) {
    super();
  }

  async read(
    principal: ResolvedBoardPrincipalV1,
    request: HitlReadOperationRequestV1,
    signal: AbortSignal,
  ): Promise<BoardOperationResultV1> {
    const parsed = BoardOperationRequestParserV1.parse(request);
    if (!parsed.ok || parsed.data.value.type !== 'hitl.read') {
      throw new BoardContractError(parsed.ok ? internalHitlFailure().boardError : parsed.error);
    }
    let current = await this.probe(principal, request);
    current = await this.expireIfDue(principal, request, current);
    if (request.wait === null) return result(request, current.interaction, false);
    const cursor = request.wait.afterStateUpdatedAt;
    if (current.interaction.stateUpdatedAt > cursor)
      return result(request, current.interaction, true);
    const startedAt = this.clock();
    const deadline = startedAt + request.wait.timeoutMs;
    const key = `${request.boardId}\0${request.hitlRequestId}`;
    while (true) {
      if (signal.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
      const now = this.clock();
      if (now >= deadline) {
        current = await this.probe(principal, request);
        current = await this.expireIfDue(principal, request, current);
        return result(request, current.interaction, current.interaction.stateUpdatedAt > cursor);
      }
      const generation = this.waits.generation(key);
      current = await this.probe(principal, request);
      current = await this.expireIfDue(principal, request, current);
      if (current.interaction.stateUpdatedAt > cursor)
        return result(request, current.interaction, true);
      const expiryDelay =
        current.interaction.state === 'open'
          ? Math.max(0, Date.parse(current.interaction.expiresAt as TimestampV1) - this.clock())
          : Number.POSITIVE_INFINITY;
      const delay = Math.max(0, Math.min(1_000, deadline - this.clock(), expiryDelay));
      await this.waits.wait(key, generation, delay, signal);
    }
  }

  private async probe(
    principal: ResolvedBoardPrincipalV1,
    request: HitlReadOperationRequestV1,
  ): Promise<StoredInteractionV1> {
    return this.accessPolicy.withAuthorizedBoardTransaction(
      {
        principal,
        operation: 'hitl.read',
        boardId: request.boardId,
        isolation: 'REPEATABLE_READ_CUT',
      },
      async (connection, context) => {
        await this.assertViewerCurrentHeadReference(connection, context, request.hitlRequestId);
        const stored = await this.interactions.readByPublicId(
          connection,
          request.boardId,
          request.hitlRequestId,
        );
        if (stored === null) throw hitlNotFound(request.hitlRequestId);
        return stored;
      },
    );
  }

  private async assertViewerCurrentHeadReference(
    connection: PoolConnection,
    context: AuthorizedBoardContextV1,
    hitlRequestId: string,
  ): Promise<void> {
    if (context?.membership?.membershipRole !== 'viewer') return;
    if (this.checkpoints === null) throw boardNotFound();
    const [rows] = await connection.execute<CurrentHeadCheckpointRow[]>(
      `
      SELECT
        CASE WHEN p.revision_pk IS NOT NULL
          THEN p.schema_version ELSE r.scene_schema_version END AS schemaVersion,
        CASE WHEN p.revision_pk IS NOT NULL
          THEN p.codec ELSE r.scene_codec END AS codec,
        CASE WHEN p.revision_pk IS NOT NULL
          THEN p.payload ELSE r.scene_payload END AS payload,
        CASE WHEN p.revision_pk IS NOT NULL
          THEN p.canonical_bytes ELSE r.scene_canonical_bytes END AS canonicalBytes,
        CASE WHEN p.revision_pk IS NOT NULL
          THEN p.stored_bytes ELSE r.scene_stored_bytes END AS storedBytes,
        CASE WHEN p.revision_pk IS NOT NULL
          THEN p.payload_sha256 ELSE r.scene_sha256 END AS sha256
      FROM board_heads h
      JOIN board_revisions r
        ON r.board_pk = h.board_pk AND r.revision_pk = h.head_revision_pk
      LEFT JOIN board_revision_payloads p
        ON p.revision_pk = r.revision_pk AND p.state = 'available'
      WHERE h.board_pk = ?
      LIMIT 1
    `,
      [context.membership.boardPk.toString()],
    );
    const row = rows[0];
    if (
      rows.length !== 1 ||
      row === undefined ||
      typeof row.schemaVersion !== 'string' ||
      typeof row.codec !== 'string' ||
      !Buffer.isBuffer(row.payload) ||
      typeof row.canonicalBytes !== 'number' ||
      !Number.isSafeInteger(row.canonicalBytes) ||
      typeof row.storedBytes !== 'number' ||
      !Number.isSafeInteger(row.storedBytes) ||
      !Buffer.isBuffer(row.sha256)
    ) {
      throw boardNotFound();
    }
    const checkpoint = await this.checkpoints.decode({
      schemaVersion: row.schemaVersion,
      codec: row.codec,
      payload: row.payload,
      canonicalBytes: row.canonicalBytes,
      storedBytes: row.storedBytes,
      sha256: row.sha256,
    });
    const ids =
      checkpoint.kind === 'scene'
        ? extractUniqueSceneHitlRequestIds(checkpoint.scene)
        : extractUniqueDocumentHitlRequestIds(checkpoint.document);
    if (!ids.includes(hitlRequestId as (typeof ids)[number])) throw boardNotFound();
  }

  private async expireIfDue(
    principal: ResolvedBoardPrincipalV1,
    request: HitlReadOperationRequestV1,
    stored: StoredInteractionV1,
  ): Promise<StoredInteractionV1> {
    if (
      stored.interaction.state !== 'open' ||
      this.clock() < Date.parse(stored.interaction.expiresAt as TimestampV1)
    )
      return stored;
    await this.expiry.expireForAuthorizedRead({
      principal,
      boardId: request.boardId,
      hitlRequestId: request.hitlRequestId,
    });
    return this.probe(principal, request);
  }
}
