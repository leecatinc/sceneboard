import { Controller, Get, Inject, Req, Res } from '@nestjs/common';

import { RequireBoardPrincipal, type BoardPrincipalRequest } from '../common/guards/board-principal.guard.js';
import { RequireOrigin } from '../common/guards/origin.guard.js';
import { APP_ENVIRONMENT, type AppEnvironment } from '../config/env.schema.js';
import { BoardSseService, type BoardSseRequestLifecycleV1, type BoardSseResponseV1 } from './board-sse.service.js';
import {
  RequireBrowserBoardStream,
  type BrowserBoardStreamRequestV1,
} from './stream-admission.guard.js';

interface BoardStreamHttpRequest extends BoardPrincipalRequest, BrowserBoardStreamRequestV1, BoardSseRequestLifecycleV1 {}

@Controller('api/v1/boards')
export class BoardSseController {
  constructor(
    @Inject(BoardSseService) private readonly streams: BoardSseService,
    @Inject(APP_ENVIRONMENT) private readonly environment: AppEnvironment,
  ) {}

  @Get(':boardId/events')
  @RequireBrowserBoardStream()
  @RequireBoardPrincipal()
  @RequireOrigin()
  async events(
    @Req() request: BoardStreamHttpRequest,
    @Res() response: BoardSseResponseV1,
  ): Promise<void> {
    const admission = request.boardStreamAdmission;
    const principal = request.boardPrincipal;
    if (admission === undefined || principal?.kind !== 'user') throw new Error('browser stream admission invariant failed');
    await this.streams.stream({
      principal,
      boardId: admission.boardId,
      cursor: admission.cursor,
      tabId: admission.tabId,
      presenceState: admission.presenceState,
      allowedOrigin: this.environment.browserOrigin,
      request,
      response,
    });
  }
}
