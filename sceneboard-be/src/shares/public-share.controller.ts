import { All, Controller, Get, Inject, Param, Req, Res } from '@nestjs/common';

import { PublicShareHttpError } from './public-share.error.js';
import { PublicShareProjectionService } from './public-share-projection.service.js';
import { applyPublicProjectionHeaders } from './share-response-policy.js';
import { D2RateLimited } from '../rate-limit/d2-rate-limit.guards.js';

interface PublicRequest {
  method?: string | undefined;
  url?: string | undefined;
  headers: Record<string, string | string[] | undefined>;
}

interface PublicJsonResponse {
  status(code: number): PublicJsonResponse;
  setHeader(name: string, value: string | readonly string[]): unknown;
  json(value: unknown): unknown;
}

const header = (request: PublicRequest, name: string): string | undefined => {
  const value = request.headers[name];
  if (Array.isArray(value)) throw new PublicShareHttpError(400);
  return value;
};

const assertProjectionGet = (request: PublicRequest): void => {
  const source = request.url ?? '';
  const parsed = new URL(source, 'http://sceneboard.internal');
  if (
    parsed.search !== '' ||
    header(request, 'transfer-encoding') !== undefined ||
    (header(request, 'content-length') !== undefined &&
      header(request, 'content-length') !== '0') ||
    header(request, 'range') !== undefined
  )
    throw new PublicShareHttpError(400);
};

@Controller('api/v1/public')
export class PublicShareController {
  constructor(
    @Inject(PublicShareProjectionService)
    private readonly projections: PublicShareProjectionService,
  ) {}

  @Get('shares/:shareToken')
  @D2RateLimited('public-share-read')
  async initial(
    @Req() request: PublicRequest,
    @Res() response: PublicJsonResponse,
    @Param('shareToken') shareToken: string,
  ): Promise<void> {
    assertProjectionGet(request);
    const result = await this.projections.initial({
      shareToken,
      cookieHeader: header(request, 'cookie'),
    });
    applyPublicProjectionHeaders(response, 200);
    if (result.setCookies.length > 0) response.setHeader('Set-Cookie', result.setCookies);
    response.status(200).json(result.state);
  }

  @Get('share-contexts/:contextId')
  @D2RateLimited('public-share-read')
  async revalidate(
    @Req() request: PublicRequest,
    @Res() response: PublicJsonResponse,
    @Param('contextId') contextId: string,
  ): Promise<void> {
    assertProjectionGet(request);
    const result = await this.projections.revalidate({
      contextId,
      cookieHeader: header(request, 'cookie'),
    });
    applyPublicProjectionHeaders(response, 200);
    if (result.setCookies.length > 0) response.setHeader('Set-Cookie', result.setCookies);
    response.status(200).json(result.state);
  }

  @All('shares/:shareToken')
  unsupportedInitial(): never {
    throw new PublicShareHttpError(405);
  }

  @All('share-contexts/:contextId')
  unsupportedRevalidation(): never {
    throw new PublicShareHttpError(405);
  }
}
