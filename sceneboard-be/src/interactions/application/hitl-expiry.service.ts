import {
  HitlInteractionParserV1,
  type BoardId,
  type EventId,
  type HitlInteractionV1,
  type HitlRequestId,
  type RequestId,
  type TimestampV1,
} from '@sceneboard/board-schema';
import type { PoolConnection } from 'mysql2/promise';

import { generatePublicUuidV4 } from '../../common/ids/public-uuid.storage.js';
import { formatMysqlTimestampUtc } from '../../common/time/mysql-timestamp.js';
import type {
  BoardAccessPolicy,
  ResolvedBoardPrincipalV1,
} from '../../grants/board-access.policy.js';
import { ControlMutationRepository } from '../../revisions/control-mutation.repository.js';
import type { LockedControlMutationHeadV1 } from '../../revisions/control-mutation.repository.js';
import { InteractionRepository } from '../persistence/interaction.repository.js';
import type { StoredInteractionV1 } from '../persistence/interaction-row.mapper.js';
import { HitlAuditPolicy } from '../hitl-audit.policy.js';
import { hitlUpdatedEvent } from './hitl-event.js';
import { hitlNotFound, internalHitlFailure } from './hitl-errors.js';
import { HitlWaitCoordinator } from './hitl-wait-coordinator.js';

const SYSTEM_EXPIRY_REQUEST_ID = 'hitl-expiry-v1' as RequestId;

export class HitlExpiryService {
  constructor(
    private readonly accessPolicy: BoardAccessPolicy,
    private readonly interactions: InteractionRepository,
    private readonly mutations: ControlMutationRepository,
    private readonly waits: HitlWaitCoordinator,
    private readonly audit: HitlAuditPolicy,
    private readonly clock: () => Date = () => new Date(),
    private readonly eventId: () => string = generatePublicUuidV4,
  ) {}

  async expireForAuthorizedRead(input: {
    principal: ResolvedBoardPrincipalV1;
    boardId: BoardId;
    hitlRequestId: HitlRequestId;
  }): Promise<HitlInteractionV1> {
    const now = this.clock();
    if (!Number.isFinite(now.valueOf())) throw internalHitlFailure();
    const occurredAt = now.toISOString() as TimestampV1;
    const eventId = this.eventId() as EventId;
    const interaction = await this.accessPolicy.withAuthorizedBoardTransaction(
      {
        principal: input.principal,
        operation: 'hitl.read',
        boardId: input.boardId,
        isolation: 'REPEATABLE_READ_CUT',
      },
      async (connection) => {
        const head = await this.mutations.lockCurrentHead(connection, input.boardId, false);
        const stored = await this.interactions.lockByBoardPk(
          connection,
          head.boardPk,
          input.hitlRequestId,
        );
        if (stored === null) throw hitlNotFound(input.hitlRequestId);
        if (
          stored.interaction.state !== 'open' ||
          now.valueOf() < Date.parse(stored.interaction.expiresAt as TimestampV1)
        ) {
          return stored.interaction;
        }
        return this.expireLocked(connection, {
          head,
          boardId: input.boardId,
          stored,
          now,
          eventId,
          occurredAt,
          context: null,
          requestId: SYSTEM_EXPIRY_REQUEST_ID,
        });
      },
    );
    this.waits.notify(`${input.boardId}\0${input.hitlRequestId}`);
    return interaction;
  }

  async expireLocked(
    connection: PoolConnection,
    input: {
      head: LockedControlMutationHeadV1;
      boardId: BoardId;
      stored: StoredInteractionV1;
      now: Date;
      eventId: EventId;
      occurredAt: TimestampV1;
      context: Parameters<HitlAuditPolicy['writeSuccess']>[1]['context'];
      requestId: RequestId;
    },
  ): Promise<HitlInteractionV1> {
    const expiresAt = Date.parse(input.stored.interaction.expiresAt as TimestampV1);
    if (
      input.stored.interaction.state !== 'open' ||
      !Number.isFinite(input.now.valueOf()) ||
      input.now.valueOf() < expiresAt ||
      Date.parse(input.occurredAt) < expiresAt
    )
      throw internalHitlFailure();
    const sequence = await this.mutations.allocateSequenceAt(
      connection,
      input.head,
      formatMysqlTimestampUtc(input.now),
    );
    await this.interactions.expire(connection, { stored: input.stored, sequence });
    const parsed = HitlInteractionParserV1.parse({
      ...input.stored.interaction,
      state: 'expired',
      stateUpdatedAt: input.stored.interaction.expiresAt,
    });
    if (!parsed.ok) throw internalHitlFailure();
    await this.mutations.appendEvent(
      connection,
      input.head,
      hitlUpdatedEvent({
        boardId: input.boardId,
        eventId: input.eventId,
        sequence,
        occurredAt: input.occurredAt,
        interaction: parsed.data.value,
      }),
    );
    await this.audit.writeSuccess(connection, {
      event: 'hitl.request.expired',
      context: input.context,
      boardPk: input.head.boardPk,
      hitlPk: input.stored.hitlPk,
      requestId: input.requestId,
      interaction: parsed.data.value,
      priorState: 'open',
      eventSequence: sequence,
    });
    return parsed.data.value;
  }
}
