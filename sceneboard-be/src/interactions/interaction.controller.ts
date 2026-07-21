import { Controller, Get, Inject, Param, Query, Req } from '@nestjs/common';
import { AppError } from '../common/errors/app-error.js';
import {
  RequireBoardPrincipal,
  type BoardPrincipalRequest,
} from '../common/guards/board-principal.guard.js';
import {
  admitBoardRequestId,
  type BoardRequestCorrelationCarrier,
} from '../common/http/board-request-correlation.js';
import { ActorContextService } from '../grants/actor-context.service.js';
import type { ResolvedBoardPrincipalV1 } from '../grants/board-access.policy.js';
import {
  boardHttpSuccess,
  type BoardHttpSuccessEnvelopeV1,
} from '../boards/board-http-envelope.js';
import { InteractionQueryService } from './application/interaction-query.service.js';
import { parseHitlReadQuery } from './interaction-http.dto.js';

interface InteractionHttpRequest extends BoardPrincipalRequest, BoardRequestCorrelationCarrier {
  aborted?: boolean;
  once?(event: 'aborted', listener: () => void): void;
  off?(event: 'aborted', listener: () => void): void;
}

const principal = (
  request: InteractionHttpRequest,
  actors: ActorContextService,
): ResolvedBoardPrincipalV1 => {
  if (request.boardPrincipal !== undefined) return request.boardPrincipal;
  if (request.authSession !== undefined) return actors.resolveUser(request.authSession);
  throw new AppError('UNAUTHENTICATED');
};

@Controller('api/v1/boards/:boardId/interactions')
@RequireBoardPrincipal()
export class InteractionController {
  constructor(
    @Inject(InteractionQueryService) private readonly queries: InteractionQueryService,
    @Inject(ActorContextService) private readonly actors: ActorContextService,
  ) {}

  @Get(':hitlRequestId')
  async read(
    @Req() request: InteractionHttpRequest,
    @Param('boardId') boardId: string,
    @Param('hitlRequestId') hitlRequestId: string,
    @Query() query: unknown,
  ): Promise<BoardHttpSuccessEnvelopeV1> {
    const requestId = admitBoardRequestId(
      request,
      typeof (query as { requestId?: unknown } | null)?.requestId === 'string'
        ? (query as { requestId: string }).requestId
        : undefined,
    );
    const parsed = parseHitlReadQuery({ query, requestId, boardId, hitlRequestId });
    const abort = new AbortController();
    const onAborted = (): void => abort.abort(new DOMException('Aborted', 'AbortError'));
    if (request.aborted) onAborted();
    request.once?.('aborted', onAborted);
    try {
      const response = await this.queries.read(
        principal(request, this.actors),
        parsed,
        abort.signal,
      );
      return boardHttpSuccess(response);
    } finally {
      request.off?.('aborted', onAborted);
    }
  }
}
