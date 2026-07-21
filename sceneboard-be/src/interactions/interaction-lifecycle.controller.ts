import { Controller, HttpCode, Inject, Param, Post, Req } from '@nestjs/common';
import type { BoardId, HitlRequestId } from '@sceneboard/board-schema';

import { AppError } from '../common/errors/app-error.js';
import { RequireCsrf } from '../common/guards/csrf.guard.js';
import {
  RequireBoardPrincipal,
  type BoardPrincipalRequest,
} from '../common/guards/board-principal.guard.js';
import { D1_PARSED_BODY } from '../common/http/strict-json-body.middleware.js';
import {
  admitBoardRequestId,
  type BoardRequestCorrelationCarrier,
} from '../common/http/board-request-correlation.js';
import { ActorContextService } from '../grants/actor-context.service.js';
import type { ResolvedBoardPrincipalV1 } from '../grants/board-access.policy.js';
import { InteractionLifecycleService } from './application/interaction-lifecycle.service.js';
import type {
  HitlLifecycleAdapterResultV1,
  HitlSupersedeAdapterRequestV1,
} from './application/hitl-lifecycle-application.port.js';
import { parseHitlLifecycleBody } from './interaction-http.dto.js';

interface LifecycleHttpRequest extends BoardPrincipalRequest, BoardRequestCorrelationCarrier {
  [D1_PARSED_BODY]?: unknown;
}

const principal = (
  request: LifecycleHttpRequest,
  actors: ActorContextService,
): ResolvedBoardPrincipalV1 => {
  if (request.boardPrincipal !== undefined) return request.boardPrincipal;
  if (request.authSession !== undefined) return actors.resolveUser(request.authSession);
  throw new AppError('UNAUTHENTICATED');
};

@Controller('api/v1/boards/:boardId/interactions')
@RequireBoardPrincipal()
export class InteractionLifecycleController {
  constructor(
    @Inject(InteractionLifecycleService) private readonly lifecycle: InteractionLifecycleService,
    @Inject(ActorContextService) private readonly actors: ActorContextService,
  ) {}

  @Post(':hitlRequestId/cancel')
  @HttpCode(200)
  @RequireCsrf('session')
  async cancel(
    @Req() request: LifecycleHttpRequest,
    @Param('boardId') boardId: BoardId,
    @Param('hitlRequestId') hitlRequestId: HitlRequestId,
  ): Promise<HitlLifecycleAdapterResultV1> {
    const body = request[D1_PARSED_BODY];
    const candidate = body as { requestId?: unknown } | null;
    const requestId = admitBoardRequestId(
      request,
      typeof candidate?.requestId === 'string' ? candidate.requestId : undefined,
    );
    const parsed = parseHitlLifecycleBody({
      body,
      requestId,
      boardId,
      hitlRequestId,
      action: 'cancel',
    });
    return this.lifecycle.cancel({
      principal: principal(request, this.actors),
      boardId,
      hitlRequestId,
      request: parsed,
    });
  }

  @Post(':hitlRequestId/supersede')
  @HttpCode(200)
  @RequireCsrf('session')
  async supersede(
    @Req() request: LifecycleHttpRequest,
    @Param('boardId') boardId: BoardId,
    @Param('hitlRequestId') hitlRequestId: HitlRequestId,
  ): Promise<HitlLifecycleAdapterResultV1> {
    const body = request[D1_PARSED_BODY];
    const candidate = body as { requestId?: unknown } | null;
    const requestId = admitBoardRequestId(
      request,
      typeof candidate?.requestId === 'string' ? candidate.requestId : undefined,
    );
    const parsed = parseHitlLifecycleBody({
      body,
      requestId,
      boardId,
      hitlRequestId,
      action: 'supersede',
    }) as HitlSupersedeAdapterRequestV1;
    return this.lifecycle.supersede({
      principal: principal(request, this.actors),
      boardId,
      hitlRequestId,
      request: parsed,
    });
  }
}
