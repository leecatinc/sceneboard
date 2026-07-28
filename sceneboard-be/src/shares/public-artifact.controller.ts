import { All, Controller, Get, Inject, Param, Req, Res } from '@nestjs/common';

import { PublicArtifactDeliveryService } from './public-artifact-delivery.service.js';
import { PublicShareHttpError } from './public-share.error.js';
import { applyPublicArtifactHeaders } from './share-response-policy.js';
import { D2RateLimited } from '../rate-limit/d2-rate-limit.guards.js';

interface ArtifactRequest {
  url?: string | undefined;
  headers: Record<string, string | string[] | undefined>;
}

interface ArtifactResponse {
  status(code: number): ArtifactResponse;
  setHeader(name: string, value: string): unknown;
  end(body?: Buffer): unknown;
}

const header = (request: ArtifactRequest, name: string): string | undefined => {
  const value = request.headers[name];
  if (Array.isArray(value)) throw new PublicShareHttpError(400);
  return value;
};

const contextQuery = (request: ArtifactRequest): string => {
  const source = request.url ?? '';
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

const assertResourceGet = (request: ArtifactRequest): void => {
  if (
    header(request, 'transfer-encoding') !== undefined ||
    (header(request, 'content-length') !== undefined && header(request, 'content-length') !== '0')
  )
    throw new PublicShareHttpError(400);
};

@Controller('api/v1/public/shares')
export class PublicArtifactController {
  constructor(
    @Inject(PublicArtifactDeliveryService)
    private readonly artifacts: PublicArtifactDeliveryService,
  ) {}

  @Get(
    ':shareId/revisions/:revisionId/g/:publicationGeneration/:accessGeneration/artifacts/:artifactId/versions/:versionId/package',
  )
  @D2RateLimited('public-share-read')
  async get(
    @Req() request: ArtifactRequest,
    @Res() response: ArtifactResponse,
    @Param('shareId') shareId: string,
    @Param('revisionId') revisionId: string,
    @Param('publicationGeneration') publicationGeneration: string,
    @Param('accessGeneration') accessGeneration: string,
    @Param('artifactId') artifactId: string,
    @Param('versionId') versionId: string,
  ): Promise<void> {
    assertResourceGet(request);
    const bytes = await this.artifacts.get({
      shareId,
      revisionId,
      publicationGeneration,
      accessGeneration,
      artifactId,
      versionId,
      contextId: contextQuery(request),
      cookieHeader: header(request, 'cookie'),
      rangeHeader: header(request, 'range'),
    });
    applyPublicArtifactHeaders(response, 200);
    response.status(200).end(bytes);
  }

  @All(
    ':shareId/revisions/:revisionId/g/:publicationGeneration/:accessGeneration/artifacts/:artifactId/versions/:versionId/package',
  )
  unsupported(): never {
    throw new PublicShareHttpError(405);
  }
}
