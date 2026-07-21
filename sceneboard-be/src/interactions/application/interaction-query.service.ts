import {
  BoardOperationRequestParserV1,
  BoardOperationResultParserV1,
  type BoardOperationResultV1,
  type HitlInteractionV1,
  type TimestampV1,
} from '@sceneboard/board-schema';

import { BoardContractError } from '../../common/errors/app-error.js';
import type {
  BoardAccessPolicy,
  ResolvedBoardPrincipalV1,
} from '../../grants/board-access.policy.js';
import { InteractionRepository } from '../persistence/interaction.repository.js';
import type { StoredInteractionV1 } from '../persistence/interaction-row.mapper.js';
import {
  HitlQueryApplicationPortV1,
  type HitlReadOperationRequestV1,
} from './hitl-query-application.port.js';
import { HitlExpiryService } from './hitl-expiry.service.js';
import { hitlNotFound, internalHitlFailure } from './hitl-errors.js';
import { HitlWaitCoordinator } from './hitl-wait-coordinator.js';

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
      async (connection) => {
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
