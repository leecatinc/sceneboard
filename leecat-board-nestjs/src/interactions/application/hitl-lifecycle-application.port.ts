import type {
  BoardId,
  EventId,
  HitlInteractionV1,
  HitlRequestId,
  RequestId,
  RevisionId,
  TimestampV1,
} from '@leecat-board/board-schema';

import type { ResolvedBoardPrincipalV1 } from '../../grants/board-access.policy.js';

export type HitlCancelAdapterRequestV1 = {
  protocolVersion: 1;
  requestId: RequestId;
  expectedRevisionId: RevisionId;
  expectedStateUpdatedAt: TimestampV1;
};

export type HitlSupersedeAdapterRequestV1 = HitlCancelAdapterRequestV1 & {
  successorHitlRequestId: HitlRequestId;
};

export type HitlLifecycleAdapterResultV1 = {
  protocolVersion: 1;
  type: 'hitl.lifecycle.result';
  requestId: RequestId;
  boardId: BoardId;
  action: 'cancel' | 'supersede';
  replayed: boolean;
  eventIds: EventId[];
  hitl: HitlInteractionV1;
};

export abstract class HitlLifecycleApplicationPortV1 {
  abstract cancel(input: {
    principal: ResolvedBoardPrincipalV1;
    boardId: BoardId;
    hitlRequestId: HitlRequestId;
    request: HitlCancelAdapterRequestV1;
  }): Promise<HitlLifecycleAdapterResultV1>;

  abstract supersede(input: {
    principal: ResolvedBoardPrincipalV1;
    boardId: BoardId;
    hitlRequestId: HitlRequestId;
    request: HitlSupersedeAdapterRequestV1;
  }): Promise<HitlLifecycleAdapterResultV1>;
}
