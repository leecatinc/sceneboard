import {
  BoardOperationResultParserV1,
  type BoardId,
  type BoardOperationResultV1,
  type RequestId,
} from '@sceneboard/board-schema';

import { BoardPersistenceError } from '../common/errors/board-persistence.error.js';
import type { BoardAccessPolicy, ResolvedBoardPrincipalV1 } from '../grants/board-access.policy.js';
import {
  currentBoardCapabilitiesFromContext,
  currentBoardSessionAccessFromContext,
} from '../grants/current-board-capabilities.js';

export class BoardCapabilitiesService {
  constructor(private readonly accessPolicy: BoardAccessPolicy) {}

  async get(input: {
    principal: ResolvedBoardPrincipalV1;
    requestId: RequestId;
    boardId: BoardId;
    documentSchemaVersion?: 1 | 2 | 3;
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
            capabilities:
              input.documentSchemaVersion === 3
                ? currentBoardCapabilitiesFromContext(context, 3)
                : input.documentSchemaVersion === 2
                  ? currentBoardCapabilitiesFromContext(context, 2)
                  : currentBoardCapabilitiesFromContext(context, 1),
            sessionAccess: currentBoardSessionAccessFromContext(context),
          },
        });
        if (!parsed.ok) throw new BoardPersistenceError('row_integrity');
        return parsed.data.value;
      },
    );
  }
}
