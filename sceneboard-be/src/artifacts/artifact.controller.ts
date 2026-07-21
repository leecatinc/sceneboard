import { Controller, Get, HttpCode, Inject, Param, Post, Query, Req, Res } from '@nestjs/common';
import {
  ArtifactReferenceParserV1,
  BoardOperationRequestParserV1,
  type RequestId,
} from '@sceneboard/board-schema';

import {
  boardHttpSuccess,
  type BoardHttpSuccessEnvelopeV1,
} from '../boards/board-http-envelope.js';
import { BoardContractError } from '../common/errors/app-error.js';
import { invalidBoardPayload } from '../common/errors/board-error.factory.js';
import {
  RequireBoardPrincipal,
  type BoardPrincipalRequest,
} from '../common/guards/board-principal.guard.js';
import { RequireCsrf } from '../common/guards/csrf.guard.js';
import { generatePublicUuidV4 } from '../common/ids/public-uuid.storage.js';
import {
  admitBoardRequestId,
  type BoardRequestCorrelationCarrier,
} from '../common/http/board-request-correlation.js';
import { D1_PARSED_BODY } from '../common/http/strict-json-body.middleware.js';
import { ActorContextService } from '../grants/actor-context.service.js';
import type { ResolvedBoardPrincipalV1 } from '../grants/board-access.policy.js';
import { ArtifactApplicationService } from './artifact-application.service.js';
import type { ArtifactGetRequestV1 } from './artifact-application.port.js';
import { ArtifactCapabilityBrokerService } from './artifact-capability-broker.service.js';
import { parseArtifactNetworkFetchRequestV1 } from './artifact-network.dto.js';
import { BoardArtifactPutSourceV1Parser } from './artifact-http.dto.js';

interface ArtifactHttpRequest extends BoardPrincipalRequest, BoardRequestCorrelationCarrier {
  [D1_PARSED_BODY]?: unknown;
}

interface BinaryResponse {
  status(code: number): BinaryResponse;
  setHeader(name: string, value: string): unknown;
  end(body?: Buffer): unknown;
}

const invalid = (issue: string, path: Array<string | number> = []): BoardContractError => {
  const error = invalidBoardPayload(issue);
  error.details = { path, issue };
  return new BoardContractError(error);
};

const principal = (
  request: ArtifactHttpRequest,
  actors: ActorContextService,
): ResolvedBoardPrincipalV1 => {
  if (request.boardPrincipal !== undefined) return request.boardPrincipal;
  if (request.authSession !== undefined) return actors.resolveUser(request.authSession);
  throw invalid('authentication required');
};

const browserPrincipal = (
  request: ArtifactHttpRequest,
  actors: ActorContextService,
): ResolvedBoardPrincipalV1 => {
  if (request.authSession === undefined || request.boardPrincipal?.kind !== 'user') {
    throw new BoardContractError({
      protocolVersion: 1,
      type: 'board.error',
      code: 'FORBIDDEN',
      message: 'Forbidden',
      category: 'auth',
      retryable: false,
      httpStatusHint: 403,
      details: null,
    });
  }
  return actors.resolveUser(request.authSession);
};

const requestId = (request: ArtifactHttpRequest, value?: unknown): RequestId => {
  const header = request.headers?.['x-request-id'];
  return admitBoardRequestId(
    request,
    value ?? (typeof header === 'string' ? header : generatePublicUuidV4()),
  );
};

const singletonQuery = (query: unknown): Record<string, string> => {
  if (query === null || typeof query !== 'object' || Array.isArray(query))
    throw invalid('invalid query');
  const source = query as Record<string, unknown>;
  const result: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [key, value] of Object.entries(source)) {
    if (typeof value !== 'string' || value.length === 0)
      throw invalid('invalid query field', [key]);
    result[key] = value;
  }
  return result;
};

const artifactGetRequest = (
  request: ArtifactHttpRequest,
  pathBoardId: string,
  pathArtifactId: string,
  pathVersionId: string,
  requestIdValue: unknown,
): ArtifactGetRequestV1 => {
  const artifact = ArtifactReferenceParserV1.parse({
    artifactId: pathArtifactId,
    versionId: pathVersionId,
  });
  if (!artifact.ok) throw new BoardContractError(artifact.error);
  const parsed = BoardOperationRequestParserV1.parse({
    protocolVersion: 1,
    requestId: requestId(request, requestIdValue),
    type: 'artifact.get',
    boardId: pathBoardId,
    artifact: artifact.data.value,
  });
  if (!parsed.ok || parsed.data.value.type !== 'artifact.get') {
    throw new BoardContractError(
      parsed.ok ? invalidBoardPayload('expected artifact.get') : parsed.error,
    );
  }
  return parsed.data.value as ArtifactGetRequestV1;
};

@Controller('api/v1/boards')
@RequireBoardPrincipal()
export class ArtifactController {
  constructor(
    @Inject(ArtifactApplicationService) private readonly artifacts: ArtifactApplicationService,
    @Inject(ArtifactCapabilityBrokerService)
    private readonly broker: ArtifactCapabilityBrokerService,
    @Inject(ActorContextService) private readonly actors: ActorContextService,
  ) {}

  @Post(':boardId/artifacts')
  @HttpCode(200)
  @RequireCsrf('session')
  async publish(
    @Req() request: ArtifactHttpRequest,
    @Param('boardId') pathBoardId: string,
  ): Promise<BoardHttpSuccessEnvelopeV1> {
    const source = BoardArtifactPutSourceV1Parser.parseOrThrow(request[D1_PARSED_BODY]);
    if (source.boardId !== pathBoardId)
      throw invalid('path and body board IDs differ', ['boardId']);
    const result = await this.artifacts.publish({
      principal: principal(request, this.actors),
      requestId: requestId(request),
      source,
    });
    return boardHttpSuccess(result);
  }

  @Get(':boardId/artifacts/:artifactId/versions/:versionId')
  async get(
    @Req() request: ArtifactHttpRequest,
    @Param('boardId') pathBoardId: string,
    @Param('artifactId') pathArtifactId: string,
    @Param('versionId') pathVersionId: string,
    @Query() queryValue: unknown,
  ): Promise<BoardHttpSuccessEnvelopeV1> {
    const query = singletonQuery(queryValue);
    if (Object.keys(query).some((key) => key !== 'requestId') || query.requestId === undefined) {
      throw invalid('requestId is required', ['requestId']);
    }
    const operation = artifactGetRequest(
      request,
      pathBoardId,
      pathArtifactId,
      pathVersionId,
      query.requestId,
    );
    const result = await this.artifacts.get({
      principal: principal(request, this.actors),
      request: operation,
    });
    return boardHttpSuccess(result);
  }

  @Get(':boardId/artifacts/:artifactId/versions/:versionId/package')
  async getPackage(
    @Req() request: ArtifactHttpRequest,
    @Param('boardId') pathBoardId: string,
    @Param('artifactId') pathArtifactId: string,
    @Param('versionId') pathVersionId: string,
    @Query() queryValue: unknown,
    @Res() response: BinaryResponse,
  ): Promise<void> {
    if (Object.keys(singletonQuery(queryValue)).length !== 0) throw invalid('query is not allowed');
    const operation = artifactGetRequest(
      request,
      pathBoardId,
      pathArtifactId,
      pathVersionId,
      generatePublicUuidV4(),
    );
    const bytes = await this.artifacts.getPackage({
      principal: browserPrincipal(request, this.actors),
      request: operation,
    });
    response.status(200);
    response.setHeader('Content-Type', 'application/vnd.leecat.artifact-package.v1');
    response.setHeader('Cache-Control', 'private, no-store');
    response.setHeader('Vary', 'Origin, Cookie, Authorization');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.end(bytes);
  }

  @Post(':boardId/artifacts/:artifactId/versions/:versionId/capability-requests/network-fetch')
  @HttpCode(200)
  @RequireCsrf('session')
  async networkFetch(
    @Req() request: ArtifactHttpRequest,
    @Param('boardId') pathBoardId: string,
    @Param('artifactId') pathArtifactId: string,
    @Param('versionId') pathVersionId: string,
    @Query() queryValue: unknown,
  ): Promise<never> {
    if (Object.keys(singletonQuery(queryValue)).length !== 0) throw invalid('query is not allowed');
    const body = parseArtifactNetworkFetchRequestV1(request[D1_PARSED_BODY]);
    admitBoardRequestId(request, body.requestId);
    const artifact = ArtifactReferenceParserV1.parse({
      artifactId: pathArtifactId,
      versionId: pathVersionId,
    });
    if (!artifact.ok) throw new BoardContractError(artifact.error);
    return this.broker.networkFetch({
      principal: browserPrincipal(request, this.actors),
      boardId: pathBoardId as never,
      artifact: artifact.data.value,
      request: body,
    });
  }
}
