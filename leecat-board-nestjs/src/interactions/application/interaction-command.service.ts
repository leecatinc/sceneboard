import {
  HitlInteractionParserV1,
  MutationEnvelopeParserV1,
  MutationRequestParserV1,
  MutationResultParserV1,
  type HitlInteractionV1,
  type MutationRequestV1,
  type MutationResultV1,
  type TimestampV1,
} from '@leecat-board/board-schema';
import type { PoolConnection } from 'mysql2/promise';

import { BoardContractError } from '../../common/errors/app-error.js';
import { formatMysqlTimestampUtc } from '../../common/time/mysql-timestamp.js';
import type {
  AuthorizedBoardContextV1,
  BoardAccessPolicy,
  ResolvedBoardPrincipalV1,
} from '../../grants/board-access.policy.js';
import {
  ControlMutationRepository,
  prepareControlMutationV1,
  type PreparedControlMutationV1,
} from '../../revisions/control-mutation.repository.js';
import { InteractionRepository, isDuplicateInteractionIdError } from '../persistence/interaction.repository.js';
import type { StoredInteractionV1 } from '../persistence/interaction-row.mapper.js';
import { HitlAuditPolicy } from '../hitl-audit.policy.js';
import { HitlExpiryService } from './hitl-expiry.service.js';
import {
  HitlMutationApplicationPortV1,
  type HitlRequestMutationEnvelopeV1,
  type HitlRespondMutationEnvelopeV1,
} from './hitl-mutation-application.port.js';
import { hitlUpdatedEvent } from './hitl-event.js';
import {
  forbiddenHitlResponse,
  hitlExpired,
  hitlIdConflict,
  hitlNotFound,
  hitlResponseConflict,
  internalHitlFailure,
  invalidHitlResponse,
} from './hitl-errors.js';
import { HitlWaitCoordinator } from './hitl-wait-coordinator.js';

const EXPIRY_MS = 15 * 60 * 1_000;

type ExpiredDuringRespond = {
  kind: 'expired';
  error: BoardContractError;
};

const expiredOutcome = (
  value: MutationResultV1 | ExpiredDuringRespond,
): value is ExpiredDuringRespond => 'kind' in value;

const asRequest = (envelope: HitlRequestMutationEnvelopeV1 | HitlRespondMutationEnvelopeV1): MutationRequestV1 => {
  const { actor: _actor, ...request } = envelope;
  const parsed = MutationRequestParserV1.parse(request);
  if (!parsed.ok) throw new BoardContractError(parsed.error);
  return parsed.data.value;
};

const assertActor = (
  context: AuthorizedBoardContextV1,
  envelope: HitlRequestMutationEnvelopeV1 | HitlRespondMutationEnvelopeV1,
): void => {
  const parsed = MutationEnvelopeParserV1.parse(envelope);
  if (!parsed.ok || parsed.data.value.actor.principalKind !== context.actor.principalKind
    || parsed.data.value.actor.principalId !== context.actor.principalId
    || parsed.data.value.actor.grantId !== context.actor.grantId
    || parsed.data.value.actor.scopes.join('\0') !== context.actor.scopes.join('\0')) {
    throw internalHitlFailure();
  }
};

const result = (input: {
  request: MutationRequestV1;
  prepared: PreparedControlMutationV1;
  interaction: HitlInteractionV1;
}): MutationResultV1 => {
  const parsed = MutationResultParserV1.parse({
    protocolVersion: 1,
    type: 'mutation.result',
    requestId: input.request.requestId,
    boardId: input.request.boardId,
    replayed: false,
    eventIds: [input.prepared.eventId],
    result: { type: input.request.command.type, hitl: input.interaction },
  });
  if (!parsed.ok) throw internalHitlFailure();
  return parsed.data.value;
};

const terminalError = (stored: StoredInteractionV1): BoardContractError => {
  const state = stored.interaction.state;
  if (state === 'expired') return hitlExpired(
    stored.interaction.hitlRequestId,
    stored.interaction.expiresAt as TimestampV1,
  );
  if (state === 'answered' || state === 'superseded' || state === 'cancelled') {
    return hitlResponseConflict(stored.interaction.hitlRequestId, state);
  }
  throw internalHitlFailure();
};

export class InteractionCommandService extends HitlMutationApplicationPortV1 {
  constructor(
    private readonly accessPolicy: BoardAccessPolicy,
    private readonly interactions: InteractionRepository,
    private readonly mutations: ControlMutationRepository,
    private readonly expiry: HitlExpiryService,
    private readonly waits: HitlWaitCoordinator,
    private readonly audit: HitlAuditPolicy,
    private readonly clock: () => Date = () => new Date(),
  ) {
    super();
  }

  async apply(input: {
    principal: ResolvedBoardPrincipalV1;
    request: MutationRequestV1;
  }): Promise<MutationResultV1> {
    if (input.request.command.type !== 'hitl.request' && input.request.command.type !== 'hitl.respond') {
      throw internalHitlFailure();
    }
    const now = this.clock();
    if (!Number.isFinite(now.valueOf())) throw internalHitlFailure();
    const prepared = prepareControlMutationV1({ principal: input.principal, request: input.request, now });
    const envelope = { ...input.request, actor: input.principal.actor } as (
      HitlRequestMutationEnvelopeV1 | HitlRespondMutationEnvelopeV1
    );
    const outcome = await this.accessPolicy.withAuthorizedBoardTransaction({
      principal: input.principal,
      operation: input.request.command.type,
      boardId: input.request.boardId,
      isolation: 'READ_COMMITTED_WRITE',
    }, async (connection, context) => {
      if (envelope.command.type === 'hitl.request') {
        return this.requestPrepared(
          connection, context, envelope as HitlRequestMutationEnvelopeV1, prepared,
        );
      }
      return this.respondPrepared(
        connection, context, envelope as HitlRespondMutationEnvelopeV1, prepared,
      );
    });
    if (expiredOutcome(outcome)) throw outcome.error;
    this.waits.notify(`${input.request.boardId}\0${input.request.command.hitlRequestId}`);
    return outcome;
  }

  async request(
    connection: PoolConnection,
    context: AuthorizedBoardContextV1,
    envelope: HitlRequestMutationEnvelopeV1,
  ): Promise<MutationResultV1> {
    const request = asRequest(envelope);
    const prepared = prepareControlMutationV1({ principal: { actor: context.actor }, request });
    return this.requestPrepared(connection, context, envelope, prepared);
  }

  async respond(
    connection: PoolConnection,
    context: AuthorizedBoardContextV1,
    envelope: HitlRespondMutationEnvelopeV1,
  ): Promise<MutationResultV1> {
    const request = asRequest(envelope);
    const prepared = prepareControlMutationV1({ principal: { actor: context.actor }, request });
    const outcome = await this.respondPrepared(connection, context, envelope, prepared);
    if (expiredOutcome(outcome)) throw outcome.error;
    return outcome;
  }

  private async requestPrepared(
    connection: PoolConnection,
    context: AuthorizedBoardContextV1,
    envelope: HitlRequestMutationEnvelopeV1,
    prepared: PreparedControlMutationV1,
  ): Promise<MutationResultV1> {
    assertActor(context, envelope);
    const request = asRequest(envelope);
    const admission = await this.mutations.begin(connection, context, request, prepared);
    if (admission.kind === 'replay') return admission.result;
    const head = await this.mutations.lockHead(connection, request);
    const sequence = await this.mutations.allocateSequence(connection, head, prepared);
    const expires = new Date(Date.parse(prepared.occurredAt) + EXPIRY_MS);
    const expiresAt = expires.toISOString() as TimestampV1;
    let interaction: HitlInteractionV1;
    try {
      interaction = await this.interactions.create(connection, {
        head,
        context,
        hitlRequestId: envelope.command.hitlRequestId,
        definition: envelope.command.request,
        requestId: request.requestId,
        sequence,
        createdAt: prepared.occurredAt,
        createdAtSql: prepared.occurredAtSql,
        expiresAt,
        expiresAtSql: formatMysqlTimestampUtc(expires),
      });
    } catch (error) {
      if (isDuplicateInteractionIdError(error)) throw hitlIdConflict(envelope.command.hitlRequestId);
      throw error;
    }
    await this.mutations.appendEvent(connection, head, hitlUpdatedEvent({
      boardId: request.boardId,
      eventId: prepared.eventId,
      sequence,
      occurredAt: prepared.occurredAt,
      interaction,
    }));
    const completed = await this.mutations.complete(
      connection, admission.recordPk, head, prepared, result({ request, prepared, interaction }),
    );
    await this.audit.writeSuccess(connection, {
      event: 'hitl.request.created',
      context,
      boardPk: head.boardPk,
      requestId: request.requestId,
      interaction,
      priorState: 'absent',
      eventSequence: sequence,
    });
    return completed;
  }

  private async respondPrepared(
    connection: PoolConnection,
    context: AuthorizedBoardContextV1,
    envelope: HitlRespondMutationEnvelopeV1,
    prepared: PreparedControlMutationV1,
  ): Promise<MutationResultV1 | ExpiredDuringRespond> {
    assertActor(context, envelope);
    const request = asRequest(envelope);
    const admission = await this.mutations.begin(connection, context, request, prepared);
    if (admission.kind === 'replay') return admission.result;
    const head = await this.mutations.lockHead(connection, request);
    const stored = await this.interactions.lockByBoardPk(
      connection, head.boardPk, envelope.command.hitlRequestId,
    );
    if (stored === null) throw hitlNotFound(envelope.command.hitlRequestId);
    if (stored.interaction.state !== 'open') throw terminalError(stored);
    const createdMs = Date.parse(stored.interaction.createdAt);
    const expiresMs = Date.parse(stored.interaction.expiresAt as TimestampV1);
    const operationMs = Math.max(Date.parse(prepared.occurredAt), createdMs + 1);
    if (operationMs >= expiresMs) {
      await this.expiry.expireLocked(connection, {
        head,
        boardId: request.boardId,
        eventId: prepared.eventId,
        stored,
        now: new Date(operationMs),
        occurredAt: prepared.occurredAt,
        context,
        requestId: request.requestId,
      });
      await this.mutations.abandonPending(connection, admission.recordPk);
      return { kind: 'expired', error: hitlExpired(
        envelope.command.hitlRequestId, stored.interaction.expiresAt as TimestampV1,
      ) };
    }
    if (stored.interaction.definition.kind === 'confirmation'
      && stored.interaction.definition.impact === 'destructive'
      && envelope.command.response.kind === 'confirmation'
      && envelope.command.response.confirmed
      && context.actor.principalKind !== 'user') throw forbiddenHitlResponse();
    const answeredAt = new Date(operationMs).toISOString() as TimestampV1;
    const candidate = HitlInteractionParserV1.parse({
      ...stored.interaction,
      state: 'answered',
      stateUpdatedAt: answeredAt,
      response: envelope.command.response,
      answeredAt,
    });
    if (!candidate.ok) throw invalidHitlResponse();
    const sequence = await this.mutations.allocateSequence(connection, head, prepared);
    await this.interactions.answer(connection, {
      stored,
      context,
      requestId: request.requestId,
      response: envelope.command.response,
      sequence,
      answeredAtSql: formatMysqlTimestampUtc(new Date(operationMs)),
    });
    await this.mutations.appendEvent(connection, head, hitlUpdatedEvent({
      boardId: request.boardId,
      eventId: prepared.eventId,
      sequence,
      occurredAt: prepared.occurredAt,
      interaction: candidate.data.value,
    }));
    const completed = await this.mutations.complete(
      connection, admission.recordPk, head, prepared,
      result({ request, prepared, interaction: candidate.data.value }),
    );
    await this.audit.writeSuccess(connection, {
      event: 'hitl.response.answered',
      context,
      boardPk: head.boardPk,
      hitlPk: stored.hitlPk,
      requestId: request.requestId,
      interaction: candidate.data.value,
      priorState: 'open',
      eventSequence: sequence,
    });
    return completed;
  }
}
