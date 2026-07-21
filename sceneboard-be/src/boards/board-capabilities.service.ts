import {
  BoardOperationResultParserV1,
  type BoardId,
  type BoardOperationResultV1,
  type RequestId,
} from '@sceneboard/board-schema';

import { BoardPersistenceError } from '../common/errors/board-persistence.error.js';
import type { BoardAccessPolicy, ResolvedBoardPrincipalV1 } from '../grants/board-access.policy.js';
import { currentBoardCapabilitiesFromContext } from '../grants/current-board-capabilities.js';

export class BoardCapabilitiesService {
  constructor(private readonly accessPolicy: BoardAccessPolicy) {}

  async get(input: {
    principal: ResolvedBoardPrincipalV1;
    requestId: RequestId;
    boardId: BoardId;
  }): Promise<BoardOperationResultV1> {
    return this.accessPolicy.withAuthorizedBoardTransaction(
      {
        principal: input.principal,
        operation: 'capabilities.get',
        boardId: input.boardId,
        isolation: 'REPEATABLE_READ_CUT',
      },
      async (_connection, context) => {
        const parsed = BoardOperationResultParserV1.parse({
          protocolVersion: 1,
          type: 'board.operation.result',
          requestId: input.requestId,
          replayed: false,
          result: {
            type: 'capabilities.get',
            capabilities: currentBoardCapabilitiesFromContext(context),
          },
        });
        if (!parsed.ok) throw new BoardPersistenceError('row_integrity');
        return parsed.data.value;
      },
    );
  }
}
