import type {
  ActorContextV1,
  BoardId,
  HitlRequestDefinitionV1,
  HitlRequestId,
  HitlResponseV1,
  IdempotencyKey,
  MutationResultV1,
  RequestId,
  RevisionId,
} from '@leecat-board/board-schema';
import type { PoolConnection } from 'mysql2/promise';

import type { AuthorizedBoardContextV1 } from '../../grants/board-access.policy.js';

export type HitlRequestMutationEnvelopeV1 = {
  protocolVersion: 1;
  requestId: RequestId;
  idempotencyKey: IdempotencyKey;
  boardId: BoardId;
  expectedRevisionId: RevisionId;
  command: {
    type: 'hitl.request';
    hitlRequestId: HitlRequestId;
    request: HitlRequestDefinitionV1;
  };
  actor: ActorContextV1;
};

export type HitlRespondMutationEnvelopeV1 = {
  protocolVersion: 1;
  requestId: RequestId;
  idempotencyKey: IdempotencyKey;
  boardId: BoardId;
  expectedRevisionId: RevisionId;
  command: {
    type: 'hitl.respond';
    hitlRequestId: HitlRequestId;
    response: HitlResponseV1;
  };
  actor: ActorContextV1;
};

export abstract class HitlMutationApplicationPortV1 {
  abstract request(
    connection: PoolConnection,
    context: AuthorizedBoardContextV1,
    envelope: HitlRequestMutationEnvelopeV1,
  ): Promise<MutationResultV1>;

  abstract respond(
    connection: PoolConnection,
    context: AuthorizedBoardContextV1,
    envelope: HitlRespondMutationEnvelopeV1,
  ): Promise<MutationResultV1>;
}
