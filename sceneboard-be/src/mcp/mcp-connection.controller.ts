import { Controller, Get, Inject, Query, Req } from '@nestjs/common';
import { BoardIdParserV1, type BoardId } from '@sceneboard/board-schema';

import { accountApiKeyRequiredScopes } from '../api-keys/account-api-key-authorization.policy.js';
import { AppError, BoardContractError } from '../common/errors/app-error.js';
import { invalidBoardPayload } from '../common/errors/board-error.factory.js';
import {
  RequireBoardPrincipal,
  type BoardPrincipalRequest,
} from '../common/guards/board-principal.guard.js';
import {
  admitBoardRequestId,
  type BoardRequestCorrelationCarrier,
} from '../common/http/board-request-correlation.js';
import { authorizationRuleFor, isBoardAccessOperation } from '../grants/board-access.policy.js';
import { BoardOperationRateLimited } from '../rate-limit/board-operation-rate-limit.policy.js';
import type {
  McpConnectionAuthorizationOperationV1,
  McpConnectionQueryV1,
  SafeAuthorizedConnectionV1,
} from './mcp-connection.dto.js';
import { McpConnectionService } from './mcp-connection.service.js';

interface McpConnectionRequest extends BoardPrincipalRequest, BoardRequestCorrelationCarrier {}

const parseQuery = (
  request: McpConnectionRequest,
  value: unknown,
): McpConnectionQueryV1 & { requestId: ReturnType<typeof admitBoardRequestId> } => {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new BoardContractError(invalidBoardPayload('invalid query'));
  const query = value as Record<string, unknown>;
  const keys = Object.keys(query);
  if (
    !keys.includes('requestId') ||
    keys.some((key) => key !== 'requestId' && key !== 'boardId' && key !== 'authorizationOperation')
  ) {
    throw new BoardContractError(invalidBoardPayload('unknown or missing query field'));
  }
  const requestId = admitBoardRequestId(request, query.requestId);
  let boardId: BoardId | null = null;
  if (query.boardId !== undefined) {
    if (typeof query.boardId !== 'string')
      throw new BoardContractError(invalidBoardPayload('boardId must be a scalar'));
    const parsedBoardId = BoardIdParserV1.parse(query.boardId);
    if (!parsedBoardId.ok) throw new BoardContractError(parsedBoardId.error);
    boardId = parsedBoardId.data.value;
  }
  let authorizationOperation: McpConnectionAuthorizationOperationV1 | null = null;
  if (query.authorizationOperation !== undefined) {
    if (
      typeof query.authorizationOperation !== 'string' ||
      accountApiKeyRequiredScopes(query.authorizationOperation) === null ||
      !isBoardAccessOperation(query.authorizationOperation) ||
      authorizationRuleFor(query.authorizationOperation).target !== 'board'
    )
      throw new BoardContractError(invalidBoardPayload('invalid authorization operation'));
    authorizationOperation = query.authorizationOperation as McpConnectionAuthorizationOperationV1;
  }
  const accountApiKey = request.boardPrincipal?.kind === 'account_api_key';
  if (
    (accountApiKey && (boardId === null) !== (authorizationOperation === null)) ||
    (!accountApiKey && authorizationOperation !== null)
  )
    throw new BoardContractError(invalidBoardPayload('invalid authorization target'));
  return { requestId, boardId, authorizationOperation };
};

@Controller('api/v1/mcp')
export class McpConnectionController {
  constructor(@Inject(McpConnectionService) private readonly connections: McpConnectionService) {}

  @Get('connection')
  @RequireBoardPrincipal()
  @BoardOperationRateLimited('board-read')
  async get(
    @Query() query: unknown,
    @Req() request: McpConnectionRequest,
  ): Promise<SafeAuthorizedConnectionV1> {
    if (request.boardPrincipal === undefined) throw new AppError('UNAUTHENTICATED');
    return this.connections.get({
      principal: request.boardPrincipal,
      ...parseQuery(request, query),
    });
  }
}
