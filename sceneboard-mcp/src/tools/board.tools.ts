import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import type { BoardId, IdempotencyKey, RequestId, ShortText } from '@sceneboard/board-schema';

import { ProtectedBoardGatewayV1 } from './protected-board.gateway.js';
import {
  createRequestIdV1,
  GlobalIdSchemaV1,
  IdempotencyKeySchemaV1,
  ShortTextSchemaV1,
} from './tool-schemas.js';
import {
  notConnectedV1,
  sdkToolResultV1,
  toolFailureV1,
  toolSuccessV1,
  validationFailureV1,
} from './tool-result.js';

export const BoardListInputSchemaV1 = z
  .object({
    cursor: z
      .string()
      .min(1)
      .max(512)
      .regex(/^[A-Za-z0-9_-]+$/)
      .nullable(),
    limit: z.number().int().min(1).max(100),
    includeArchived: z.boolean(),
  })
  .strict();
export const BoardGetInputSchemaV1 = z.object({ boardId: GlobalIdSchemaV1 }).strict();
export const BoardCreateInputSchemaV1 = z
  .object({ title: ShortTextSchemaV1, idempotencyKey: IdempotencyKeySchemaV1 })
  .strict();
export const BoardRenameInputSchemaV1 = z
  .object({ boardId: GlobalIdSchemaV1, title: ShortTextSchemaV1 })
  .strict();
export const BoardArchiveInputSchemaV1 = z
  .object({
    boardId: GlobalIdSchemaV1,
    confirm: z.literal(true),
    idempotencyKey: IdempotencyKeySchemaV1,
  })
  .strict();
export const BoardCapabilitiesInputSchemaV1 = BoardGetInputSchemaV1;

const invalid = (
  tool: Parameters<typeof validationFailureV1>[0],
  requestId: string,
  parsed: z.SafeParseError<unknown>,
): CallToolResult => validationFailureV1(tool, requestId, parsed.error);

const disconnected = (
  tool: Parameters<typeof toolFailureV1>[0],
  requestId: string,
): CallToolResult =>
  toolFailureV1(tool, requestId, 'mcp', notConnectedV1() as unknown as Record<string, unknown>);

export class BoardToolHandlersV1 {
  constructor(private readonly gateway: ProtectedBoardGatewayV1) {}

  async list(raw: unknown, signal?: AbortSignal): Promise<CallToolResult> {
    const requestId = createRequestIdV1();
    const parsed = BoardListInputSchemaV1.safeParse(raw);
    if (!parsed.success) return invalid('board_list', requestId, parsed);
    const result = await this.gateway.call(
      'board_list',
      'board.list',
      { signal },
      (client, _snapshot, operationSignal) =>
        client.listBoards(
          {
            protocolVersion: 1,
            requestId: requestId as RequestId,
            type: 'board.list',
            cursor: parsed.data.cursor as never,
            limit: parsed.data.limit,
            includeArchived: parsed.data.includeArchived,
          },
          operationSignal,
        ),
    );
    return result.connected
      ? sdkToolResultV1('board_list', requestId, result.value, null)
      : disconnected('board_list', requestId);
  }

  async get(raw: unknown, signal?: AbortSignal): Promise<CallToolResult> {
    const requestId = createRequestIdV1();
    const parsed = BoardGetInputSchemaV1.safeParse(raw);
    if (!parsed.success) return invalid('board_get', requestId, parsed);
    const result = await this.gateway.call(
      'board_get',
      'board.get',
      { signal },
      (client, _snapshot, operationSignal) =>
        client.getBoard(
          {
            protocolVersion: 1,
            requestId: requestId as RequestId,
            type: 'board.get',
            boardId: parsed.data.boardId as BoardId,
          },
          operationSignal,
        ),
    );
    return result.connected
      ? sdkToolResultV1('board_get', requestId, result.value, null)
      : disconnected('board_get', requestId);
  }

  async create(raw: unknown, signal?: AbortSignal): Promise<CallToolResult> {
    const requestId = createRequestIdV1();
    const parsed = BoardCreateInputSchemaV1.safeParse(raw);
    if (!parsed.success) return invalid('board_create', requestId, parsed);
    const result = await this.gateway.call(
      'board_create',
      'board.create',
      { signal },
      (client, _snapshot, operationSignal) =>
        client.createBoard(
          {
            protocolVersion: 1,
            requestId: requestId as RequestId,
            type: 'board.create',
            title: parsed.data.title as ShortText,
            idempotencyKey: parsed.data.idempotencyKey as IdempotencyKey,
          },
          operationSignal,
        ),
    );
    return result.connected
      ? sdkToolResultV1('board_create', requestId, result.value, null)
      : disconnected('board_create', requestId);
  }

  async rename(raw: unknown, signal?: AbortSignal): Promise<CallToolResult> {
    const requestId = createRequestIdV1();
    const parsed = BoardRenameInputSchemaV1.safeParse(raw);
    if (!parsed.success) return invalid('board_rename', requestId, parsed);
    const result = await this.gateway.renameBoard({
      boardId: parsed.data.boardId,
      title: parsed.data.title,
      ...(signal === undefined ? {} : { signal }),
    });
    if (!result.connected) return disconnected('board_rename', requestId);
    if (result.value.ok) return toolSuccessV1('board_rename', requestId, result.value.value, null);
    if (result.value.source === 'board')
      return toolFailureV1(
        'board_rename',
        requestId,
        'board',
        result.value.error as unknown as Record<string, unknown>,
      );
    return toolFailureV1('board_rename', requestId, 'mcp', {
      code:
        result.value.error.code === 'CANCELLED'
          ? 'BOARD_MCP_CANCELLED'
          : result.value.error.code === 'TIMEOUT'
            ? 'BOARD_MCP_TIMEOUT'
            : result.value.error.code === 'TRANSPORT_ERROR'
              ? 'BOARD_MCP_TRANSPORT_ERROR'
              : 'BOARD_MCP_RESPONSE_INVALID',
      message:
        result.value.error.code === 'CANCELLED'
          ? 'Tool call was cancelled'
          : result.value.error.code === 'TIMEOUT'
            ? 'SceneBoard request timed out'
            : result.value.error.code === 'TRANSPORT_ERROR'
              ? 'SceneBoard transport is unavailable'
              : 'SceneBoard response is invalid',
      retryable:
        result.value.error.code === 'TIMEOUT' || result.value.error.code === 'TRANSPORT_ERROR',
      details:
        result.value.error.code === 'TIMEOUT' ? { timeoutMs: result.value.error.timeoutMs } : null,
    });
  }

  async archive(raw: unknown, signal?: AbortSignal): Promise<CallToolResult> {
    const requestId = createRequestIdV1();
    const parsed = BoardArchiveInputSchemaV1.safeParse(raw);
    if (!parsed.success) return invalid('board_archive', requestId, parsed);
    const result = await this.gateway.call(
      'board_archive',
      'board.archive',
      { signal },
      (client, _snapshot, operationSignal) =>
        client.archiveBoard(
          {
            protocolVersion: 1,
            requestId: requestId as RequestId,
            type: 'board.archive',
            boardId: parsed.data.boardId as BoardId,
            confirm: true,
            idempotencyKey: parsed.data.idempotencyKey as IdempotencyKey,
          },
          operationSignal,
        ),
    );
    return result.connected
      ? sdkToolResultV1('board_archive', requestId, result.value, null)
      : disconnected('board_archive', requestId);
  }

  async capabilities(raw: unknown, signal?: AbortSignal): Promise<CallToolResult> {
    const requestId = createRequestIdV1();
    const parsed = BoardCapabilitiesInputSchemaV1.safeParse(raw);
    if (!parsed.success) return invalid('board_capabilities_get', requestId, parsed);
    const result = await this.gateway.call(
      'board_capabilities_get',
      'capabilities.get',
      { signal },
      (client, _snapshot, operationSignal) =>
        client.getCapabilities(
          {
            protocolVersion: 1,
            requestId: requestId as RequestId,
            type: 'capabilities.get',
            boardId: parsed.data.boardId as BoardId,
          },
          operationSignal,
        ),
    );
    return result.connected
      ? sdkToolResultV1('board_capabilities_get', requestId, result.value, null)
      : disconnected('board_capabilities_get', requestId);
  }
}
