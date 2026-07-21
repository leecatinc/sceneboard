import type { HitlInteractionV1, RequestId } from '@sceneboard/board-schema';
import type { PoolConnection } from 'mysql2/promise';

import type { AuditEventName } from '../audit/audit-events.js';
import { AuditRepository } from '../audit/audit.repository.js';
import type { AuthorizedBoardContextV1 } from '../grants/board-access.policy.js';

type HitlAuditEventName = Extract<
  AuditEventName,
  | 'hitl.request.created'
  | 'hitl.response.answered'
  | 'hitl.request.cancelled'
  | 'hitl.request.superseded'
  | 'hitl.request.expired'
  | 'hitl.response.conflict'
>;

export class HitlAuditPolicy {
  constructor(private readonly audit: AuditRepository) {}

  async writeSuccess(
    connection: PoolConnection,
    input: {
      event: Exclude<HitlAuditEventName, 'hitl.response.conflict'>;
      context: AuthorizedBoardContextV1 | null;
      boardPk: string;
      hitlPk?: string;
      requestId: RequestId;
      interaction: HitlInteractionV1;
      priorState: 'absent' | HitlInteractionV1['state'];
      eventSequence: number;
    },
  ): Promise<void> {
    const actor = input.context?.actor ?? null;
    await this.audit.writeMandatory(
      { connection },
      {
        event: input.event,
        actorPublicId: actor?.principalId ?? 'hitl-expiry-v1',
        userPublicId: actor?.principalKind === 'user' ? actor.principalId : null,
        sessionPublicId: null,
        clientPublicId: actor?.principalKind === 'mcp_client' ? actor.principalId : null,
        grantPublicId: actor?.grantId ?? null,
        subjectFingerprint: null,
        metadata: {
          boardPk: input.boardPk,
          ...(input.hitlPk === undefined ? {} : { hitlPk: input.hitlPk }),
          requestId: input.requestId,
          actorKind: actor?.principalKind ?? 'service',
          interactionKind: input.interaction.definition.kind,
          impact:
            input.interaction.definition.kind === 'confirmation'
              ? input.interaction.definition.impact
              : 'none',
          priorState: input.priorState,
          nextState: input.interaction.state,
          eventSequence: input.eventSequence,
          replayed: false,
          outcome: 'success',
        },
      },
    );
  }
}
