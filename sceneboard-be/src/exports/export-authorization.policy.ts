import type { BoardId } from '@sceneboard/board-schema';
import type { PoolConnection } from 'mysql2/promise';

import type {
  AuthorizedBoardContextV1,
  BoardAccessPolicy,
  ResolvedBoardPrincipalV1,
} from '../grants/board-access.policy.js';
import { BoardContractError } from '../common/errors/app-error.js';
import { DatabaseOperationAbortedError } from '../database/transaction.js';
import { ExportFailureV1 } from './export-errors.js';

export class ExportAuthorizationPolicyV1 {
  constructor(private readonly boards: BoardAccessPolicy) {}

  async authorize<T>(input: {
    principal: ResolvedBoardPrincipalV1;
    boardId: BoardId;
    signal: AbortSignal;
    deadlineMs: number;
    retainTransactionUntilApplySettles?: boolean;
    apply: (connection: PoolConnection, context: AuthorizedBoardContextV1) => Promise<T>;
  }): Promise<T> {
    if (input.principal.kind === 'mcp') throw new ExportFailureV1('EXPORT_FORBIDDEN');
    if (
      input.principal.kind === 'user' &&
      (!input.principal.isBrowserCredential || input.principal.actor.principalKind !== 'user')
    )
      throw new ExportFailureV1('EXPORT_FORBIDDEN');
    if (
      input.principal.kind === 'account_api_key' &&
      (input.principal.isBrowserCredential || input.principal.actor.principalKind !== 'service')
    )
      throw new ExportFailureV1('EXPORT_FORBIDDEN');
    try {
      return await this.boards.withAuthorizedBoardTransaction(
        {
          principal: input.principal,
          operation: 'export.render',
          boardId: input.boardId,
          isolation: 'REPEATABLE_READ_CUT',
          ...(input.retainTransactionUntilApplySettles === true
            ? {}
            : { ownership: { signal: input.signal, deadlineMs: input.deadlineMs } }),
        },
        async (connection, context) => {
          if (context.access.kind !== 'owner' && context.access.kind !== 'api_key')
            throw new ExportFailureV1('EXPORT_NOT_FOUND');
          return input.apply(connection, context);
        },
      );
    } catch (error) {
      if (error instanceof ExportFailureV1) throw error;
      if (error instanceof DatabaseOperationAbortedError)
        throw new ExportFailureV1('EXPORT_RENDER_TIMEOUT');
      const code =
        error instanceof BoardContractError
          ? error.boardError.code
          : error !== null && typeof error === 'object' && 'error' in error
            ? (error as { error?: { code?: unknown } }).error?.code
            : error !== null && typeof error === 'object' && 'code' in error
              ? (error as { code?: unknown }).code
              : null;
      if (code === 'UNAUTHENTICATED') throw new ExportFailureV1('EXPORT_UNAUTHENTICATED');
      if (code === 'FORBIDDEN') throw new ExportFailureV1('EXPORT_FORBIDDEN');
      if (code === 'BOARD_NOT_FOUND') throw new ExportFailureV1('EXPORT_NOT_FOUND');
      throw error;
    }
  }
}
