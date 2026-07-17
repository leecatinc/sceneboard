import {
  HitlInteractionParserV1,
  type BoardId,
  type EventId,
  type HitlRequestId,
  type TimestampV1,
} from '@leecat-board/board-schema';

import { generatePublicUuidV4 } from '../../common/ids/public-uuid.storage.js';
import { formatMysqlTimestampUtc } from '../../common/time/mysql-timestamp.js';
import type { AuthorizedBoardContextV1, BoardAccessPolicy } from '../../grants/board-access.policy.js';
import {
  ControlMutationRepository,
  type LockedControlMutationHeadV1,
} from '../../revisions/control-mutation.repository.js';
import { InteractionRepository } from '../persistence/interaction.repository.js';
import type { StoredInteractionV1 } from '../persistence/interaction-row.mapper.js';
import { HitlAuditPolicy } from '../hitl-audit.policy.js';
import { HitlExpiryService } from './hitl-expiry.service.js';
import { hitlUpdatedEvent } from './hitl-event.js';
import {
  HitlLifecycleApplicationPortV1,
  type HitlCancelAdapterRequestV1,
  type HitlLifecycleAdapterResultV1,
  type HitlSupersedeAdapterRequestV1,
} from './hitl-lifecycle-application.port.js';
import {
  hitlExpired,
  hitlNotFound,
  hitlResponseConflict,
  internalHitlFailure,
  invalidHitlLifecycleCursor,
  forbiddenHitlResponse,
} from './hitl-errors.js';
import { HitlWaitCoordinator } from './hitl-wait-coordinator.js';

type LifecycleAction = 'cancel' | 'supersede';
type LifecycleOutcome = HitlLifecycleAdapterResultV1 | { error: ReturnType<typeof hitlExpired> };

const lifecycleConflict = (stored: StoredInteractionV1): never => {
  if (stored.interaction.state === 'expired') {
    throw hitlExpired(stored.interaction.hitlRequestId, stored.interaction.expiresAt as TimestampV1);
  }
  if (stored.interaction.state === 'answered'
    || stored.interaction.state === 'superseded'
    || stored.interaction.state === 'cancelled') {
    throw hitlResponseConflict(stored.interaction.hitlRequestId, stored.interaction.state);
  }
  throw internalHitlFailure();
};

const owns = (context: AuthorizedBoardContextV1, stored: StoredInteractionV1): boolean => (
  context.actor.principalKind === 'user'
  || (stored.createdByKind === 'M'
    && stored.createdByPrincipalId === context.actor.principalId
    && stored.createdByGrantId === context.actor.grantId)
);

export class InteractionLifecycleService extends HitlLifecycleApplicationPortV1 {
  constructor(
    private readonly accessPolicy: BoardAccessPolicy,
    private readonly interactions: InteractionRepository,
    private readonly mutations: ControlMutationRepository,
    private readonly expiry: HitlExpiryService,
    private readonly waits: HitlWaitCoordinator,
    private readonly audit: HitlAuditPolicy,
    private readonly clock: () => Date = () => new Date(),
    private readonly eventId: () => string = generatePublicUuidV4,
  ) {
    super();
  }

  async cancel(input: Parameters<HitlLifecycleApplicationPortV1['cancel']>[0]) {
    return this.apply('cancel', input);
  }

  async supersede(input: Parameters<HitlLifecycleApplicationPortV1['supersede']>[0]) {
    return this.apply('supersede', input);
  }

  private async apply(
    action: LifecycleAction,
    input: {
      principal: Parameters<HitlLifecycleApplicationPortV1['cancel']>[0]['principal'];
      boardId: BoardId;
      hitlRequestId: HitlRequestId;
      request: HitlCancelAdapterRequestV1 | HitlSupersedeAdapterRequestV1;
    },
  ): Promise<HitlLifecycleAdapterResultV1> {
    const now = this.clock();
    if (!Number.isFinite(now.valueOf())) throw internalHitlFailure();
    const occurredAt = now.toISOString() as TimestampV1;
    const eventId = this.eventId() as EventId;
    const outcome = await this.accessPolicy.withAuthorizedBoardTransaction({
      principal: input.principal,
      operation: 'hitl.request',
      boardId: input.boardId,
      isolation: 'READ_COMMITTED_WRITE',
    }, async (connection, context): Promise<LifecycleOutcome> => {
      const head = await this.mutations.lockHeadForExpected(connection, {
        boardId: input.boardId,
        expectedRevisionId: input.request.expectedRevisionId,
      });
      const rows = action === 'supersede'
        ? await this.interactions.lockPairByBoardPk(
          connection,
          head.boardPk,
          input.hitlRequestId,
          (input.request as HitlSupersedeAdapterRequestV1).successorHitlRequestId,
        )
        : [];
      const stored = action === 'supersede'
        ? rows.find((row) => row.interaction.hitlRequestId === input.hitlRequestId) ?? null
        : await this.interactions.lockByBoardPk(connection, head.boardPk, input.hitlRequestId);
      if (stored === null) throw hitlNotFound(input.hitlRequestId);
      if (!owns(context, stored)) throw forbiddenHitlResponse();
      const replay = await this.tryReplay(connection, head, action, input, stored);
      if (replay !== null) return replay;
      if (stored.interaction.state !== 'open') lifecycleConflict(stored);
      if (stored.interaction.stateUpdatedAt !== input.request.expectedStateUpdatedAt) {
        throw invalidHitlLifecycleCursor();
      }
      const createdMs = Date.parse(stored.interaction.createdAt);
      const expiresMs = Date.parse(stored.interaction.expiresAt as TimestampV1);
      const updatedMs = Math.max(now.valueOf(), createdMs + 1);
      if (updatedMs >= expiresMs) {
        const interaction = await this.expiry.expireLocked(connection, {
          head,
          boardId: input.boardId,
          stored,
          now,
          eventId,
          occurredAt,
          context,
          requestId: input.request.requestId,
        });
        return { error: hitlExpired(
          interaction.hitlRequestId, interaction.expiresAt as TimestampV1,
        ) };
      }
      let successor: StoredInteractionV1 | null = null;
      if (action === 'supersede') {
        const successorId = (input.request as HitlSupersedeAdapterRequestV1).successorHitlRequestId;
        if (successorId === input.hitlRequestId) throw invalidHitlLifecycleCursor();
        successor = rows.find((row) => row.interaction.hitlRequestId === successorId) ?? null;
        if (successor === null) throw hitlNotFound(successorId);
        if (successor.interaction.state !== 'open'
          || Date.parse(successor.interaction.createdAt) <= createdMs
          || Date.parse(successor.interaction.expiresAt as TimestampV1) <= updatedMs) {
          throw invalidHitlLifecycleCursor();
        }
        if (!owns(context, successor)) throw forbiddenHitlResponse();
      }
      const sequence = await this.mutations.allocateSequenceAt(
        connection, head, formatMysqlTimestampUtc(now),
      );
      if (action === 'cancel') {
        await this.interactions.cancel(connection, {
          stored, context, sequence, updatedAtSql: formatMysqlTimestampUtc(new Date(updatedMs)),
        });
      } else {
        if (successor === null) throw internalHitlFailure();
        await this.interactions.supersede(connection, {
          stored, successor, context, sequence, updatedAtSql: formatMysqlTimestampUtc(new Date(updatedMs)),
        });
      }
      const parsed = HitlInteractionParserV1.parse({
        ...stored.interaction,
        state: action === 'cancel' ? 'cancelled' : 'superseded',
        stateUpdatedAt: new Date(updatedMs).toISOString(),
      });
      if (!parsed.ok) throw internalHitlFailure();
      await this.mutations.appendEvent(connection, head, hitlUpdatedEvent({
        boardId: input.boardId,
        eventId,
        sequence,
        occurredAt,
        interaction: parsed.data.value,
      }));
      await this.audit.writeSuccess(connection, {
        event: action === 'cancel' ? 'hitl.request.cancelled' : 'hitl.request.superseded',
        context,
        boardPk: head.boardPk,
        hitlPk: stored.hitlPk,
        requestId: input.request.requestId,
        interaction: parsed.data.value,
        priorState: 'open',
        eventSequence: sequence,
      });
      return {
        protocolVersion: 1,
        type: 'hitl.lifecycle.result',
        requestId: input.request.requestId,
        boardId: input.boardId,
        action,
        replayed: false,
        eventIds: [eventId],
        hitl: parsed.data.value,
      };
    });
    this.waits.notify(`${input.boardId}\0${input.hitlRequestId}`);
    if ('error' in outcome) throw outcome.error;
    return outcome;
  }

  private async tryReplay(
    connection: Parameters<InteractionRepository['lockByBoardPk']>[0],
    head: LockedControlMutationHeadV1,
    action: LifecycleAction,
    input: {
      boardId: BoardId;
      hitlRequestId: HitlRequestId;
      request: HitlCancelAdapterRequestV1 | HitlSupersedeAdapterRequestV1;
    },
    stored: StoredInteractionV1,
  ): Promise<HitlLifecycleAdapterResultV1 | null> {
    const isReplay = action === 'cancel'
      ? stored.interaction.state === 'cancelled'
        && input.request.expectedStateUpdatedAt === stored.interaction.createdAt
      : stored.interaction.state === 'superseded'
        && input.request.expectedStateUpdatedAt === stored.interaction.createdAt
        && stored.supersededByRequestId
          === (input.request as HitlSupersedeAdapterRequestV1).successorHitlRequestId;
    if (!isReplay) return null;
    const originalEventId = await this.mutations.eventIdAtSequence(
      connection, head.boardPk, stored.stateEventSequence,
    );
    return {
      protocolVersion: 1,
      type: 'hitl.lifecycle.result',
      requestId: input.request.requestId,
      boardId: input.boardId,
      action,
      replayed: true,
      eventIds: [originalEventId],
      hitl: stored.interaction,
    };
  }

}
