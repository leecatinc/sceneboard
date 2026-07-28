import { Controller, Headers, HttpCode, Inject, Param, Post, Req, Res } from '@nestjs/common';
import type { MediaIngestResultV1, RequestId } from '@sceneboard/board-schema';

import { BoardContractError } from '../common/errors/app-error.js';
import { RequireCsrf } from '../common/guards/csrf.guard.js';
import {
  RequireBoardPrincipal,
  type BoardPrincipalRequest,
} from '../common/guards/board-principal.guard.js';
import { RequireOrigin } from '../common/guards/origin.guard.js';
import {
  admitSingletonBoardRequestIdQuery,
  type BoardRequestCorrelationCarrier,
} from '../common/http/board-request-correlation.js';
import { SCENEBOARD_RAW_BINARY_BODY } from '../common/http/strict-json-body.middleware.js';
import { invalidMediaRequest } from './media-errors.js';
import { MediaIngestionService } from './media-ingestion.service.js';

interface MediaRequest extends BoardPrincipalRequest, BoardRequestCorrelationCarrier {
  originalUrl?: string;
  headers: Record<string, string | string[] | undefined>;
  [SCENEBOARD_RAW_BINARY_BODY]?: Buffer;
}

interface StatusResponse {
  status(code: number): unknown;
}

export type MediaHttpSuccessEnvelopeV1 = Readonly<{
  protocolVersion: 1;
  type: 'board.http.success';
  requestId: RequestId;
  result: MediaIngestResultV1;
}>;

const oneHeader = (request: MediaRequest, name: string): string | undefined => {
  const value = request.headers[name];
  if (Array.isArray(value)) throw new BoardContractError(invalidMediaRequest('framing'));
  return value;
};

@Controller('api/v1/boards/:boardId/media')
export class MediaController {
  constructor(@Inject(MediaIngestionService) private readonly ingestion: MediaIngestionService) {}

  @Post()
  @HttpCode(201)
  @RequireBoardPrincipal('media-upload')
  @RequireOrigin('browser-or-mcp')
  @RequireCsrf('session')
  async ingest(
    @Req() request: MediaRequest,
    @Res({ passthrough: true }) response: StatusResponse,
    @Param('boardId') boardId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
  ): Promise<MediaHttpSuccessEnvelopeV1> {
    const requestId = admitSingletonBoardRequestIdQuery(request, request.originalUrl);
    const body = request[SCENEBOARD_RAW_BINARY_BODY];
    if (body === undefined) throw new BoardContractError(invalidMediaRequest('framing'));
    const contentLength = Number(oneHeader(request, 'content-length'));
    const contentType = oneHeader(request, 'content-type');
    const contentDigest = oneHeader(request, 'content-digest');
    if (!Number.isSafeInteger(contentLength) || contentDigest === undefined)
      throw new BoardContractError(invalidMediaRequest('framing'));
    const principal = request.boardPrincipal;
    if (principal === undefined) throw new BoardContractError(invalidMediaRequest('framing'));
    const outcome = await this.ingestion.ingest({
      principal,
      boardId,
      requestId,
      idempotencyKey,
      contentType,
      contentLength,
      contentDigest,
      body,
    });
    if (outcome.replayed) response.status(200);
    return {
      protocolVersion: 1,
      type: 'board.http.success',
      requestId,
      result: outcome.result,
    };
  }
}
