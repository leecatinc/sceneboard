import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import type { BoardId, IdempotencyKey, RequestId, RevisionId } from '@sceneboard/board-schema';

import { ProtectedBoardGatewayV1 } from './protected-board.gateway.js';
import { createRequestIdV1, GlobalIdSchemaV1, IdempotencyKeySchemaV1 } from './tool-schemas.js';
import {
  notConnectedV1,
  sdkToolResultV1,
  toolFailureV1,
  validationFailureV1,
} from './tool-result.js';

export const HistoryListInputSchemaV1 = z
  .object({
    boardId: GlobalIdSchemaV1,
    cursor: z
      .string()
      .min(1)
      .max(512)
      .regex(/^[A-Za-z0-9_-]+$/)
      .nullable(),
    limit: z.number().int().min(1).max(100),
  })
  .strict();
export const HistoryGetInputSchemaV1 = z
  .object({ boardId: GlobalIdSchemaV1, revisionId: GlobalIdSchemaV1 })
  .strict();
export const HistoryRestoreInputSchemaV1 = z
  .object({
    boardId: GlobalIdSchemaV1,
    revisionId: GlobalIdSchemaV1,
    expectedRevisionId: GlobalIdSchemaV1,
    confirm: z.literal(true),
    idempotencyKey: IdempotencyKeySchemaV1,
  })
  .strict();

export class HistoryToolHandlersV1 {
  constructor(private readonly gateway: ProtectedBoardGatewayV1) {}

  async list(raw: unknown, signal?: AbortSignal): Promise<CallToolResult> {
    const requestId = createRequestIdV1();
    const parsed = HistoryListInputSchemaV1.safeParse(raw);
    if (!parsed.success) return validationFailureV1('board_history_list', requestId, parsed.error);
    const result = await this.gateway.call(
      'board_history_list',
      'history.list',
      {
        signal,
        authorization: { boardId: parsed.data.boardId, operation: 'history.list' },
      },
      (client, _snapshot, operationSignal) =>
        client.listHistory(
          {
            protocolVersion: 1,
            requestId: requestId as RequestId,
            type: 'history.list',
            boardId: parsed.data.boardId as BoardId,
            cursor: parsed.data.cursor as never,
            limit: parsed.data.limit,
          },
          operationSignal,
        ),
    );
    return result.connected
      ? sdkToolResultV1(
          'board_history_list',
          requestId,
          result.value,
          result.value.ok ? { type: 'history', history: result.value.metadata.history } : null,
        )
      : toolFailureV1(
          'board_history_list',
          requestId,
          'mcp',
          notConnectedV1() as unknown as Record<string, unknown>,
        );
  }

  async get(raw: unknown, signal?: AbortSignal): Promise<CallToolResult> {
    const requestId = createRequestIdV1();
    const parsed = HistoryGetInputSchemaV1.safeParse(raw);
    if (!parsed.success) return validationFailureV1('board_history_get', requestId, parsed.error);
    const result = await this.gateway.call(
      'board_history_get',
      'history.get',
      {
        signal,
        authorization: { boardId: parsed.data.boardId, operation: 'history.get' },
      },
      (client, _snapshot, operationSignal) =>
        client.getHistory(
          {
            protocolVersion: 1,
            requestId: requestId as RequestId,
            type: 'history.get',
            boardId: parsed.data.boardId as BoardId,
            revisionId: parsed.data.revisionId as RevisionId,
          },
          operationSignal,
        ),
    );
    return result.connected
      ? sdkToolResultV1(
          'board_history_get',
          requestId,
          result.value,
          result.value.ok ? { type: 'history', history: result.value.metadata.history } : null,
        )
      : toolFailureV1(
          'board_history_get',
          requestId,
          'mcp',
          notConnectedV1() as unknown as Record<string, unknown>,
        );
  }

  async restore(raw: unknown, signal?: AbortSignal): Promise<CallToolResult> {
    const requestId = createRequestIdV1();
    const parsed = HistoryRestoreInputSchemaV1.safeParse(raw);
    if (!parsed.success)
      return validationFailureV1('board_history_restore', requestId, parsed.error);
    const result = await this.gateway.call(
      'board_history_restore',
      'scene.restore',
      {
        signal,
        authorization: { boardId: parsed.data.boardId, operation: 'scene.restore' },
      },
      (client, _snapshot, operationSignal) =>
        client.restoreRevision(
          {
            protocolVersion: 1,
            requestId: requestId as RequestId,
            boardId: parsed.data.boardId as BoardId,
            expectedRevisionId: parsed.data.expectedRevisionId as RevisionId,
            idempotencyKey: parsed.data.idempotencyKey as IdempotencyKey,
            command: {
              type: 'scene.restore',
              sourceRevisionId: parsed.data.revisionId as RevisionId,
            },
          },
          operationSignal,
        ),
    );
    return result.connected
      ? sdkToolResultV1('board_history_restore', requestId, result.value, null)
      : toolFailureV1(
          'board_history_restore',
          requestId,
          'mcp',
          notConnectedV1() as unknown as Record<string, unknown>,
        );
  }
}
