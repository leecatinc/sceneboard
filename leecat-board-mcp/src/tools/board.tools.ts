import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import type { BoardId, IdempotencyKey, RequestId, ShortText } from '@leecat-board/board-schema';

import { ProtectedBoardGatewayV1 } from './protected-board.gateway.js';
import { createRequestIdV1, GlobalIdSchemaV1, IdempotencyKeySchemaV1, ShortTextSchemaV1 } from './tool-schemas.js';
import { notConnectedV1, sdkToolResultV1, toolFailureV1, validationFailureV1 } from './tool-result.js';

export const BoardListInputSchemaV1 = z.object({ cursor: z.string().min(1).max(512).regex(/^[A-Za-z0-9_-]+$/).nullable(), limit: z.number().int().min(1).max(100), includeArchived: z.boolean() }).strict();
export const BoardGetInputSchemaV1 = z.object({ boardId: GlobalIdSchemaV1 }).strict();
export const BoardCreateInputSchemaV1 = z.object({ title: ShortTextSchemaV1, idempotencyKey: IdempotencyKeySchemaV1 }).strict();
export const BoardArchiveInputSchemaV1 = z.object({ boardId: GlobalIdSchemaV1, confirm: z.literal(true), idempotencyKey: IdempotencyKeySchemaV1 }).strict();
export const BoardCapabilitiesInputSchemaV1 = BoardGetInputSchemaV1;

const invalid = (tool: Parameters<typeof validationFailureV1>[0], requestId: string, parsed: z.SafeParseError<unknown>): CallToolResult => (
  validationFailureV1(tool, requestId, parsed.error)
);

const disconnected = (tool: Parameters<typeof toolFailureV1>[0], requestId: string): CallToolResult => (
  toolFailureV1(tool, requestId, 'mcp', notConnectedV1() as unknown as Record<string, unknown>)
);

export class BoardToolHandlersV1 {
  constructor(private readonly gateway: ProtectedBoardGatewayV1) {}

  async list(raw: unknown, signal?: AbortSignal): Promise<CallToolResult> {
    const requestId = createRequestIdV1();
    const parsed = BoardListInputSchemaV1.safeParse(raw);
    if (!parsed.success) return invalid('board_list', requestId, parsed);
    const result = await this.gateway.call((client) => client.listBoards({
      protocolVersion: 1,
      requestId: requestId as RequestId,
      type: 'board.list',
      cursor: parsed.data.cursor as never,
      limit: parsed.data.limit,
      includeArchived: parsed.data.includeArchived,
    }, signal));
    return result.connected ? sdkToolResultV1('board_list', requestId, result.value, null) : disconnected('board_list', requestId);
  }

  async get(raw: unknown, signal?: AbortSignal): Promise<CallToolResult> {
    const requestId = createRequestIdV1();
    const parsed = BoardGetInputSchemaV1.safeParse(raw);
    if (!parsed.success) return invalid('board_get', requestId, parsed);
    const result = await this.gateway.call((client) => client.getBoard({ protocolVersion: 1, requestId: requestId as RequestId, type: 'board.get', boardId: parsed.data.boardId as BoardId }, signal));
    return result.connected ? sdkToolResultV1('board_get', requestId, result.value, null) : disconnected('board_get', requestId);
  }

  async create(raw: unknown, signal?: AbortSignal): Promise<CallToolResult> {
    const requestId = createRequestIdV1();
    const parsed = BoardCreateInputSchemaV1.safeParse(raw);
    if (!parsed.success) return invalid('board_create', requestId, parsed);
    const result = await this.gateway.call((client) => client.createBoard({
      protocolVersion: 1,
      requestId: requestId as RequestId,
      type: 'board.create',
      title: parsed.data.title as ShortText,
      idempotencyKey: parsed.data.idempotencyKey as IdempotencyKey,
    }, signal));
    return result.connected ? sdkToolResultV1('board_create', requestId, result.value, null) : disconnected('board_create', requestId);
  }

  async archive(raw: unknown, signal?: AbortSignal): Promise<CallToolResult> {
    const requestId = createRequestIdV1();
    const parsed = BoardArchiveInputSchemaV1.safeParse(raw);
    if (!parsed.success) return invalid('board_archive', requestId, parsed);
    const result = await this.gateway.call((client) => client.archiveBoard({
      protocolVersion: 1,
      requestId: requestId as RequestId,
      type: 'board.archive',
      boardId: parsed.data.boardId as BoardId,
      confirm: true,
      idempotencyKey: parsed.data.idempotencyKey as IdempotencyKey,
    }, signal));
    return result.connected ? sdkToolResultV1('board_archive', requestId, result.value, null) : disconnected('board_archive', requestId);
  }

  async capabilities(raw: unknown, signal?: AbortSignal): Promise<CallToolResult> {
    const requestId = createRequestIdV1();
    const parsed = BoardCapabilitiesInputSchemaV1.safeParse(raw);
    if (!parsed.success) return invalid('board_capabilities_get', requestId, parsed);
    const result = await this.gateway.call((client) => client.getCapabilities({ protocolVersion: 1, requestId: requestId as RequestId, type: 'capabilities.get', boardId: parsed.data.boardId as BoardId }, signal));
    return result.connected ? sdkToolResultV1('board_capabilities_get', requestId, result.value, null) : disconnected('board_capabilities_get', requestId);
  }
}
