import { Controller, Get, Inject, Query, Req } from '@nestjs/common';
import { BoardIdParserV1, type BoardId } from '@sceneboard/board-schema';

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
import type { SafeAuthorizedConnectionV1 } from './mcp-connection.dto.js';
import { McpConnectionService } from './mcp-connection.service.js';

interface McpConnectionRequest extends BoardPrincipalRequest, BoardRequestCorrelationCarrier {}

const parseQuery = (
  request: McpConnectionRequest,
  value: unknown,
): { requestId: ReturnType<typeof admitBoardRequestId>; boardId: BoardId | null } => {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new BoardContractError(invalidBoardPayload('invalid query'));
  const query = value as Record<string, unknown>;
  const keys = Object.keys(query);
  if (!keys.includes('requestId') || keys.some((key) => key !== 'requestId' && key !== 'boardId')) {
    throw new BoardContractError(invalidBoardPayload('unknown or missing query field'));
  }
  const requestId = admitBoardRequestId(request, query.requestId);
  if (query.boardId === undefined) return { requestId, boardId: null };
  if (typeof query.boardId !== 'string')
    throw new BoardContractError(invalidBoardPayload('boardId must be a scalar'));
  const boardId = BoardIdParserV1.parse(query.boardId);
  if (!boardId.ok) throw new BoardContractError(boardId.error);
  return { requestId, boardId: boardId.data.value };
};

@Controller('api/v1/mcp')
export class McpConnectionController {
  constructor(@Inject(McpConnectionService) private readonly connections: McpConnectionService) {}

  @Get('connection')
  @RequireBoardPrincipal()
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
