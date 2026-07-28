import { All, Controller, Get, Inject, Param, Req, Res } from '@nestjs/common';

import { BoardContractError } from '../common/errors/app-error.js';
import {
  RequireBoardPrincipal,
  type BoardPrincipalRequest,
} from '../common/guards/board-principal.guard.js';
import { D2RateLimited } from '../rate-limit/d2-rate-limit.guards.js';
import { PublicShareHttpError } from '../shares/public-share.error.js';
import { applyPublicMediaHeaders } from '../shares/share-response-policy.js';
import {
  invalidMediaRequest,
  mediaMethodNotAllowed,
  mediaRangeNotSatisfiable,
} from './media-errors.js';
import {
  accountMediaNotModified,
  MediaDeliveryService,
  PublicMediaDeliveryService,
} from './media-delivery.service.js';
import { applyAccountMediaHeaders } from './media-response-policy.js';

interface MediaGetRequest extends BoardPrincipalRequest {
  method?: string | undefined;
  originalUrl?: string | undefined;
  url?: string | undefined;
  headers: Record<string, string | string[] | undefined>;
}

interface MediaGetResponse {
  setHeader(name: string, value: string): unknown;
  status(code: number): MediaGetResponse;
  end(body?: Buffer): unknown;
  json(value: unknown): unknown;
}

const oneHeader = (request: MediaGetRequest, name: string): string | undefined => {
  const value = request.headers[name];
  if (Array.isArray(value)) throw new BoardContractError(invalidMediaRequest('framing'));
  return value;
};

const publicHeader = (request: MediaGetRequest, name: string): string | undefined => {
  const value = request.headers[name];
  if (Array.isArray(value)) throw new PublicShareHttpError(400);
  return value;
};

const assertNoBodyOrFraming = (request: MediaGetRequest): void => {
  const length = oneHeader(request, 'content-length');
  if (
    oneHeader(request, 'transfer-encoding') !== undefined ||
    (length !== undefined && length !== '0')
  )
    throw new BoardContractError(invalidMediaRequest('framing'));
};

const assertNoAccountQuery = (request: MediaGetRequest): void => {
  const source = request.originalUrl ?? request.url ?? '';
  if (new URL(source, 'http://sceneboard.internal').search !== '')
    throw new BoardContractError(invalidMediaRequest('framing'));
};

const accountConditional = (request: MediaGetRequest): string | undefined => {
  const value = oneHeader(request, 'if-none-match');
  if (value !== undefined && !/^"sha256-[0-9a-f]{64}"$/u.test(value))
    throw new BoardContractError(invalidMediaRequest('framing'));
  return value;
};

const publicContextQuery = (request: MediaGetRequest): string => {
  const source = request.originalUrl ?? request.url ?? '';
  if (source.includes('%') || source.includes('+')) throw new PublicShareHttpError(400);
  const parsed = new URL(source, 'http://sceneboard.internal');
  const keys = [...parsed.searchParams.keys()];
  const values = parsed.searchParams.getAll('contextId');
  if (
    keys.length !== 1 ||
    keys[0] !== 'contextId' ||
    values.length !== 1 ||
    values[0] === undefined ||
    parsed.search !== `?contextId=${values[0]}`
  )
    throw new PublicShareHttpError(400);
  return values[0];
};

@Controller('api/v1/boards/:boardId/revisions/:revisionId/media')
export class AccountMediaDeliveryController {
  constructor(@Inject(MediaDeliveryService) private readonly media: MediaDeliveryService) {}

  @Get(':mediaId')
  @RequireBoardPrincipal()
  async get(
    @Req() request: MediaGetRequest,
    @Res() response: MediaGetResponse,
    @Param('boardId') boardId: string,
    @Param('revisionId') revisionId: string,
    @Param('mediaId') mediaId: string,
  ): Promise<void> {
    assertNoBodyOrFraming(request);
    assertNoAccountQuery(request);
    const ifNoneMatch = accountConditional(request);
    const range = oneHeader(request, 'range');
    const principal = request.boardPrincipal;
    if (principal === undefined) throw new BoardContractError(invalidMediaRequest('framing'));
    const authorized = await this.media.getAccount({
      principal,
      boardId,
      revisionId,
      mediaId,
    });
    if (range !== undefined) {
      applyAccountMediaHeaders(response, 416, authorized);
      const error = mediaRangeNotSatisfiable(authorized.byteLength);
      response.status(416).json({ error });
      return;
    }
    if (accountMediaNotModified(authorized, ifNoneMatch)) {
      applyAccountMediaHeaders(response, 304, authorized);
      response.status(304).end();
      return;
    }
    applyAccountMediaHeaders(response, 200, authorized);
    response.status(200).end(authorized.bytes);
  }

  @All(':mediaId')
  unsupported(): never {
    throw new BoardContractError(mediaMethodNotAllowed());
  }
}

@Controller('api/v1/public/shares')
export class PublicMediaDeliveryController {
  constructor(
    @Inject(PublicMediaDeliveryService) private readonly media: PublicMediaDeliveryService,
  ) {}

  @Get(':shareId/revisions/:revisionId/g/:publicationGeneration/:accessGeneration/media/:mediaId')
  @D2RateLimited('public-share-read')
  async get(
    @Req() request: MediaGetRequest,
    @Res() response: MediaGetResponse,
    @Param('shareId') shareId: string,
    @Param('revisionId') revisionId: string,
    @Param('publicationGeneration') publicationGeneration: string,
    @Param('accessGeneration') accessGeneration: string,
    @Param('mediaId') mediaId: string,
  ): Promise<void> {
    if (
      publicHeader(request, 'transfer-encoding') !== undefined ||
      (publicHeader(request, 'content-length') !== undefined &&
        publicHeader(request, 'content-length') !== '0')
    )
      throw new PublicShareHttpError(400);
    const range = publicHeader(request, 'range');
    const authorized = await this.media.get({
      shareId,
      revisionId,
      publicationGeneration,
      accessGeneration,
      mediaId,
      contextId: publicContextQuery(request),
      cookieHeader: publicHeader(request, 'cookie'),
    });
    if (range !== undefined) throw new PublicShareHttpError(416, null, authorized.byteLength);
    applyPublicMediaHeaders(response, 200, {
      mime: authorized.mime,
      sha256Hex: authorized.sha256Hex,
    });
    response.status(200).end(authorized.bytes);
  }

  @All(':shareId/revisions/:revisionId/g/:publicationGeneration/:accessGeneration/media/:mediaId')
  unsupported(): never {
    throw new PublicShareHttpError(405);
  }
}
