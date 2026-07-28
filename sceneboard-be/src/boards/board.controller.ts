import { Controller, Get, HttpCode, Inject, Param, Post, Query, Req, Res } from '@nestjs/common';
import {
  BOARD_LIMITS_V1,
  BoardIdParserV1,
  BoardOperationRequestParserV1,
  MutationRequestParserV1,
  MutationRequestParserV2,
  type BoardId,
  type MutationRequestV1,
  type MutationRequestV2,
  type RequestId,
  type ShortText,
} from '@sceneboard/board-schema';

import { ArtifactApplicationService } from '../artifacts/artifact-application.service.js';
import type { ArtifactStopRequestV1 } from '../artifacts/artifact-application.port.js';
import { AppError, BoardContractError } from '../common/errors/app-error.js';
import { invalidBoardPayload } from '../common/errors/board-error.factory.js';
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
import { HistoryGetService, type HistoryGetRequestV1 } from '../history/history-get.service.js';
import { HistoryListService, type HistoryListRequestV1 } from '../history/history-list.service.js';
import { InteractionCommandService } from '../interactions/application/interaction-command.service.js';
import { BoardMutationService } from '../revisions/board-mutation.service.js';
import { BoardArchiveService, type BoardArchiveRequestV1 } from './board-archive.service.js';
import { BoardCapabilitiesService } from './board-capabilities.service.js';
import { BoardCreateService, type BoardCreateRequestV1 } from './board-create.service.js';
import { BoardGetService } from './board-get.service.js';
import { boardHttpSuccess, type BoardHttpSuccessEnvelopeV1 } from './board-http-envelope.js';
import { BoardListService, type BoardListRequestV1 } from './board-list.service.js';
import {
  BoardRenameService,
  type BoardRenameRequestV1,
  type BoardRenameResultV1,
} from './board-rename.service.js';

interface BoardHttpRequest extends BoardPrincipalRequest, BoardRequestCorrelationCarrier {
  body?: unknown;
  [D1_PARSED_BODY]?: unknown;
}

interface StatusResponse {
  status(code: number): unknown;
}

const invalid = (issue: string, path: Array<string | number> = []): BoardContractError => {
  const error = invalidBoardPayload(issue);
  error.details = { path, issue };
  return new BoardContractError(error);
};

const body = (request: BoardHttpRequest): unknown => request[D1_PARSED_BODY];

const readRenameRequest = (
  request: BoardHttpRequest,
  pathBoardId: string,
): BoardRenameRequestV1 => {
  const parsedBoardId = BoardIdParserV1.parse(pathBoardId);
  if (!parsedBoardId.ok) throw invalid('invalid board ID', ['boardId']);
  const value = record(request.body, ['title']);
  if (
    typeof value.title !== 'string' ||
    value.title !== value.title.trim() ||
    value.title.length === 0 ||
    [...value.title].length > BOARD_LIMITS_V1.maxTitleChars ||
    /[\uD800-\uDFFF]/u.test(value.title)
  )
    throw invalid('invalid board title', ['title']);
  return { boardId: parsedBoardId.data.value, title: value.title as ShortText };
};

const principal = (
  request: BoardHttpRequest,
  actors: ActorContextService,
): ResolvedBoardPrincipalV1 => {
  if (request.boardPrincipal !== undefined) return request.boardPrincipal;
  if (request.authSession !== undefined) return actors.resolveUser(request.authSession);
  throw new AppError('UNAUTHENTICATED');
};

const readCreateRequest = (request: BoardHttpRequest): BoardCreateRequestV1 => {
  const parsed = BoardOperationRequestParserV1.parse(body(request));
  if (!parsed.ok) throw new BoardContractError(parsed.error);
  if (parsed.data.value.type !== 'board.create') throw invalid('expected board.create', ['type']);
  return parsed.data.value as BoardCreateRequestV1;
};

const readArchiveRequest = (
  request: BoardHttpRequest,
  pathBoardId: string,
): BoardArchiveRequestV1 => {
  const parsed = BoardOperationRequestParserV1.parse(body(request));
  if (!parsed.ok) throw new BoardContractError(parsed.error);
  if (parsed.data.value.type !== 'board.archive') throw invalid('expected board.archive', ['type']);
  if (parsed.data.value.boardId !== pathBoardId)
    throw invalid('path and body board IDs differ', ['boardId']);
  return parsed.data.value as BoardArchiveRequestV1;
};

const readMutationRequest = (request: BoardHttpRequest, pathBoardId: string): MutationRequestV2 => {
  const parsed = MutationRequestParserV2.parse(body(request));
  if (!parsed.ok) throw new BoardContractError(parsed.error);
  if (parsed.data.value.boardId !== pathBoardId)
    throw invalid('path and body board IDs differ', ['boardId']);
  return parsed.data.value;
};

const record = (value: unknown, allowed: readonly string[]): Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw invalid('invalid body');
  const source = value as Record<string, unknown>;
  if (Object.keys(source).some((key) => !allowed.includes(key)))
    throw invalid('unknown body field');
  return source;
};

const readRestoreRequest = (
  request: BoardHttpRequest,
  pathBoardId: string,
  pathRevisionId: string,
): MutationRequestV1 => {
  const value = record(body(request), [
    'protocolVersion',
    'requestId',
    'idempotencyKey',
    'expectedRevisionId',
    'confirm',
  ]);
  const requestId = admitBoardRequestId(request, value.requestId);
  if (value.confirm !== true) throw invalid('confirm must be true', ['confirm']);
  const parsed = MutationRequestParserV1.parse({
    protocolVersion: value.protocolVersion,
    requestId,
    idempotencyKey: value.idempotencyKey,
    boardId: pathBoardId,
    expectedRevisionId: value.expectedRevisionId,
    command: { type: 'scene.restore', sourceRevisionId: pathRevisionId },
  });
  if (!parsed.ok) throw new BoardContractError(parsed.error);
  return parsed.data.value;
};

const queryRecord = (value: unknown, allowed: readonly string[]): Record<string, string> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw invalid('invalid query');
  const source = value as Record<string, unknown>;
  const keys = Object.keys(source);
  if (keys.some((key) => !allowed.includes(key))) throw invalid('unknown or repeated query field');
  const result: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const key of keys) {
    const item = source[key];
    if (typeof item !== 'string' || item.length === 0)
      throw invalid('query fields must be non-empty scalars', [key]);
    result[key] = item;
  }
  return result;
};

const canonicalLimit = (value: string | undefined): number => {
  if (value === undefined || !/^[1-9][0-9]{0,2}$/.test(value))
    throw invalid('limit is required', ['limit']);
  const limit = Number(value);
  if (limit > 100) throw invalid('limit must be between 1 and 100', ['limit']);
  return limit;
};

const parseListQuery = (request: BoardHttpRequest, value: unknown): BoardListRequestV1 => {
  const query = queryRecord(value, ['requestId', 'cursor', 'limit', 'includeArchived']);
  const requestId = admitBoardRequestId(request, query.requestId);
  if (query.includeArchived !== 'true' && query.includeArchived !== 'false') {
    throw invalid('includeArchived must be true or false', ['includeArchived']);
  }
  const parsed = BoardOperationRequestParserV1.parse({
    protocolVersion: 1,
    requestId,
    type: 'board.list',
    cursor: query.cursor ?? null,
    limit: canonicalLimit(query.limit),
    includeArchived: query.includeArchived === 'true',
  });
  if (!parsed.ok || parsed.data.value.type !== 'board.list') {
    throw new BoardContractError(
      parsed.ok ? invalidBoardPayload('invalid board.list query') : parsed.error,
    );
  }
  return parsed.data.value as BoardListRequestV1;
};

const parseGetQuery = (
  request: BoardHttpRequest,
  value: unknown,
  pathBoardId: string,
): { requestId: RequestId; boardId: BoardId } => {
  const query = queryRecord(value, ['requestId']);
  const requestId = admitBoardRequestId(request, query.requestId);
  const parsed = BoardOperationRequestParserV1.parse({
    protocolVersion: 1,
    requestId,
    type: 'board.get',
    boardId: pathBoardId,
  });
  if (!parsed.ok || parsed.data.value.type !== 'board.get') {
    throw new BoardContractError(
      parsed.ok ? invalidBoardPayload('invalid board.get query') : parsed.error,
    );
  }
  return {
    requestId: parsed.data.value.requestId,
    boardId: parsed.data.value.boardId,
  };
};

const parseCapabilitiesQuery = (
  request: BoardHttpRequest,
  value: unknown,
  pathBoardId: string,
): { requestId: RequestId; boardId: BoardId } => {
  const query = queryRecord(value, ['requestId']);
  const requestId = admitBoardRequestId(request, query.requestId);
  const parsed = BoardOperationRequestParserV1.parse({
    protocolVersion: 1,
    requestId,
    type: 'capabilities.get',
    boardId: pathBoardId,
  });
  if (!parsed.ok || parsed.data.value.type !== 'capabilities.get') {
    throw new BoardContractError(
      parsed.ok ? invalidBoardPayload('invalid capabilities.get query') : parsed.error,
    );
  }
  return { requestId: parsed.data.value.requestId, boardId: parsed.data.value.boardId };
};

const parseHistoryListQuery = (
  request: BoardHttpRequest,
  value: unknown,
  pathBoardId: string,
): HistoryListRequestV1 => {
  const query = queryRecord(value, ['requestId', 'cursor', 'limit']);
  const requestId = admitBoardRequestId(request, query.requestId);
  const parsed = BoardOperationRequestParserV1.parse({
    protocolVersion: 1,
    requestId,
    type: 'history.list',
    boardId: pathBoardId,
    cursor: query.cursor ?? null,
    limit: canonicalLimit(query.limit),
  });
  if (!parsed.ok || parsed.data.value.type !== 'history.list') {
    throw new BoardContractError(
      parsed.ok ? invalidBoardPayload('invalid history.list query') : parsed.error,
    );
  }
  return parsed.data.value as HistoryListRequestV1;
};

const parseHistoryGetQuery = (
  request: BoardHttpRequest,
  value: unknown,
  pathBoardId: string,
  pathRevisionId: string,
): HistoryGetRequestV1 => {
  const query = queryRecord(value, ['requestId']);
  const requestId = admitBoardRequestId(request, query.requestId);
  const parsed = BoardOperationRequestParserV1.parse({
    protocolVersion: 1,
    requestId,
    type: 'history.get',
    boardId: pathBoardId,
    revisionId: pathRevisionId,
  });
  if (!parsed.ok || parsed.data.value.type !== 'history.get') {
    throw new BoardContractError(
      parsed.ok ? invalidBoardPayload('invalid history.get query') : parsed.error,
    );
  }
  return parsed.data.value as HistoryGetRequestV1;
};

@Controller('api/v1/boards')
@RequireBoardPrincipal()
export class BoardController {
  constructor(
    @Inject(BoardCreateService) private readonly creates: BoardCreateService,
    @Inject(BoardArchiveService) private readonly archives: BoardArchiveService,
    @Inject(BoardCapabilitiesService) private readonly capabilities: BoardCapabilitiesService,
    @Inject(BoardListService) private readonly lists: BoardListService,
    @Inject(BoardGetService) private readonly gets: BoardGetService,
    @Inject(BoardRenameService) private readonly renames: BoardRenameService,
    @Inject(BoardMutationService) private readonly mutations: BoardMutationService,
    @Inject(ArtifactApplicationService) private readonly artifacts: ArtifactApplicationService,
    @Inject(InteractionCommandService) private readonly interactions: InteractionCommandService,
    @Inject(HistoryListService) private readonly historyLists: HistoryListService,
    @Inject(HistoryGetService) private readonly historyGets: HistoryGetService,
    @Inject(ActorContextService) private readonly actors: ActorContextService,
  ) {}

  @Get()
  async list(
    @Req() request: BoardHttpRequest,
    @Query() query: unknown,
  ): Promise<BoardHttpSuccessEnvelopeV1> {
    const result = await this.lists.list({
      principal: principal(request, this.actors),
      request: parseListQuery(request, query),
    });
    return boardHttpSuccess(result);
  }

  @Post()
  @HttpCode(201)
  @RequireCsrf('session')
  async create(
    @Req() request: BoardHttpRequest,
    @Res({ passthrough: true }) response: StatusResponse,
  ): Promise<BoardHttpSuccessEnvelopeV1> {
    const result = await this.creates.create({
      principal: principal(request, this.actors),
      request: readCreateRequest(request),
    });
    if (result.replayed) response.status(200);
    return boardHttpSuccess(result);
  }

  @Get(':boardId')
  async get(
    @Req() request: BoardHttpRequest,
    @Param('boardId') pathBoardId: string,
    @Query() query: unknown,
  ): Promise<BoardHttpSuccessEnvelopeV1> {
    const parsed = parseGetQuery(request, query, pathBoardId);
    const result = await this.gets.get({
      principal: principal(request, this.actors),
      requestId: parsed.requestId,
      boardId: parsed.boardId,
    });
    return boardHttpSuccess(result);
  }

  @Get(':boardId/capabilities')
  async getCapabilities(
    @Req() request: BoardHttpRequest,
    @Param('boardId') pathBoardId: string,
    @Query() query: unknown,
  ): Promise<BoardHttpSuccessEnvelopeV1> {
    const parsed = parseCapabilitiesQuery(request, query, pathBoardId);
    const result = await this.capabilities.get({
      principal: principal(request, this.actors),
      requestId: parsed.requestId,
      boardId: parsed.boardId,
    });
    return boardHttpSuccess(result);
  }

  @Post(':boardId/title')
  @HttpCode(200)
  @RequireCsrf('session')
  async rename(
    @Req() request: BoardHttpRequest,
    @Param('boardId') pathBoardId: string,
  ): Promise<BoardRenameResultV1> {
    if (request.authSession === undefined) throw new AppError('UNAUTHENTICATED');
    return this.renames.rename({
      principal: this.actors.resolveUser(request.authSession),
      request: readRenameRequest(request, pathBoardId),
    });
  }

  @Post(':boardId/archive')
  @HttpCode(200)
  @RequireCsrf('session')
  async archive(
    @Req() request: BoardHttpRequest,
    @Param('boardId') pathBoardId: string,
  ): Promise<BoardHttpSuccessEnvelopeV1> {
    const result = await this.archives.archive({
      principal: principal(request, this.actors),
      request: readArchiveRequest(request, pathBoardId),
      auditIdentity: {
        userPublicId: request.authSession?.user.publicId ?? null,
        sessionPublicId: request.authSession?.publicId ?? null,
      },
    });
    return boardHttpSuccess(result);
  }

  @Post(':boardId/mutations')
  @HttpCode(201)
  @RequireCsrf('session')
  async mutate(
    @Req() request: BoardHttpRequest,
    @Param('boardId') pathBoardId: string,
    @Res({ passthrough: true }) response: StatusResponse,
  ): Promise<BoardHttpSuccessEnvelopeV1> {
    const parsedRequest = readMutationRequest(request, pathBoardId);
    const actor = principal(request, this.actors);
    const result =
      parsedRequest.command.type === 'artifact.stop'
        ? await this.artifacts.stop({
            principal: actor,
            request: parsedRequest as ArtifactStopRequestV1,
          })
        : parsedRequest.command.type === 'hitl.request' ||
            parsedRequest.command.type === 'hitl.respond'
          ? await this.interactions.apply({
              principal: actor,
              request: parsedRequest as MutationRequestV1,
            })
          : parsedRequest.command.type === 'document.replace'
            ? await this.mutations.applyDocumentMutation({
                principal: actor,
                request: parsedRequest,
              })
            : await this.mutations.applySceneMutation({
                principal: actor,
                request: parsedRequest as MutationRequestV1,
              });
    if (result.replayed) response.status(200);
    return boardHttpSuccess(result);
  }

  @Post(':boardId/revisions/:revisionId/restore')
  @HttpCode(200)
  @RequireCsrf('session')
  async restore(
    @Req() request: BoardHttpRequest,
    @Param('boardId') pathBoardId: string,
    @Param('revisionId') pathRevisionId: string,
  ): Promise<BoardHttpSuccessEnvelopeV1> {
    const result = await this.mutations.applySceneMutation({
      principal: principal(request, this.actors),
      request: readRestoreRequest(request, pathBoardId, pathRevisionId),
    });
    return boardHttpSuccess(result);
  }

  @Get(':boardId/revisions')
  async listHistory(
    @Req() request: BoardHttpRequest,
    @Param('boardId') pathBoardId: string,
    @Query() query: unknown,
  ): Promise<BoardHttpSuccessEnvelopeV1> {
    const response = await this.historyLists.listWithMetadata({
      principal: principal(request, this.actors),
      request: parseHistoryListQuery(request, query, pathBoardId),
    });
    return boardHttpSuccess(response.result, response.metadata);
  }

  @Get(':boardId/revisions/:revisionId')
  async getHistory(
    @Req() request: BoardHttpRequest,
    @Param('boardId') pathBoardId: string,
    @Param('revisionId') pathRevisionId: string,
    @Query() query: unknown,
  ): Promise<BoardHttpSuccessEnvelopeV1> {
    const response = await this.historyGets.getWithMetadata({
      principal: principal(request, this.actors),
      request: parseHistoryGetQuery(request, query, pathBoardId, pathRevisionId),
    });
    return boardHttpSuccess(response.result, response.metadata);
  }
}
