import type {
  BoardId,
  BoardOperationResultV1,
  HitlRequestId,
  RequestId,
  TimestampV1,
} from '@leecat-board/board-schema';

import type { ResolvedBoardPrincipalV1 } from '../../grants/board-access.policy.js';

export type HitlReadOperationRequestV1 = {
  protocolVersion: 1;
  requestId: RequestId;
  type: 'hitl.read';
  boardId: BoardId;
  hitlRequestId: HitlRequestId;
  wait: null | { afterStateUpdatedAt: TimestampV1; timeoutMs: number };
};

export abstract class HitlQueryApplicationPortV1 {
  abstract read(
    principal: ResolvedBoardPrincipalV1,
    request: HitlReadOperationRequestV1,
    signal: AbortSignal,
  ): Promise<BoardOperationResultV1>;
}
