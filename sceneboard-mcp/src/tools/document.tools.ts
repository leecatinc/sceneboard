import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import {
  BoardDocumentParserV2,
  type BoardId,
  type IdempotencyKey,
  type PageDisplayModeV1,
  type PageId,
  type RequestId,
  type RevisionId,
} from '@sceneboard/board-schema';
import {
  applyDocumentTransformV2,
  type DocumentTransformOperationV2,
} from '@sceneboard/board-sdk/document-transform';

import { ProtectedBoardGatewayV1 } from './protected-board.gateway.js';
import { createRequestIdV1, GlobalIdSchemaV1, IdempotencyKeySchemaV1 } from './tool-schemas.js';
import {
  notConnectedV1,
  sdkToolResultV1,
  toolFailureV1,
  validationFailureV1,
  type BoardToolNameV1,
} from './tool-result.js';

const CommonMutationShape = {
  boardId: GlobalIdSchemaV1,
  expectedRevisionId: GlobalIdSchemaV1,
  idempotencyKey: IdempotencyKeySchemaV1,
};

export const DocumentGetInputSchemaV2 = z
  .object({ boardId: GlobalIdSchemaV1, revisionId: GlobalIdSchemaV1.nullable() })
  .strict();
export const DocumentReplaceInputSchemaV2 = z
  .object({ ...CommonMutationShape, document: z.unknown() })
  .strict();
export const PageAddInputSchemaV2 = z
  .object({
    ...CommonMutationShape,
    page: z.unknown(),
    index: z.number().int().safe().nonnegative(),
  })
  .strict();
export const PageRemoveInputSchemaV2 = z
  .object({ ...CommonMutationShape, pageId: GlobalIdSchemaV1 })
  .strict();
export const PageReorderInputSchemaV2 = z
  .object({
    ...CommonMutationShape,
    pageId: GlobalIdSchemaV1,
    toIndex: z.number().int().safe().nonnegative(),
  })
  .strict();
export const PageUpdateInputSchemaV2 = z
  .object({
    ...CommonMutationShape,
    pageId: GlobalIdSchemaV1,
    title: z.string().optional(),
    displayMode: z.enum(['fit-page', 'fit-width', 'actual-size']).optional(),
    scene: z.unknown().optional(),
  })
  .strict()
  .refine(
    (value) =>
      Object.hasOwn(value, 'title') ||
      Object.hasOwn(value, 'displayMode') ||
      Object.hasOwn(value, 'scene'),
    { message: 'at least one page update member is required' },
  );
export const PageDefaultSetInputSchemaV2 = z
  .object({ ...CommonMutationShape, pageId: GlobalIdSchemaV1 })
  .strict();

type DocumentMutationTool =
  | 'board_document_replace'
  | 'board_page_add'
  | 'board_page_remove'
  | 'board_page_reorder'
  | 'board_page_update'
  | 'board_page_default_set';

const mismatch = (
  tool: BoardToolNameV1,
  requestId: string,
  commandType: 'document.replace' | 'scene.replace',
): CallToolResult =>
  toolFailureV1(tool, requestId, 'board', {
    protocolVersion: 1,
    type: 'board.error',
    code: 'DOCUMENT_VERSION_MISMATCH',
    message: 'Document version mismatch',
    category: 'conflict',
    retryable: false,
    httpStatusHint: 409,
    details: {
      headSchemaVersion: commandType === 'document.replace' ? 1 : 2,
      commandSchemaVersion: commandType === 'document.replace' ? 2 : 1,
      commandType,
    },
  });

const disconnected = (tool: BoardToolNameV1, requestId: string): CallToolResult =>
  toolFailureV1(tool, requestId, 'mcp', notConnectedV1() as unknown as Record<string, unknown>);

export class DocumentToolHandlersV2 {
  constructor(private readonly gateway: ProtectedBoardGatewayV1) {}

  async get(raw: unknown, signal?: AbortSignal): Promise<CallToolResult> {
    const requestId = createRequestIdV1();
    const parsed = DocumentGetInputSchemaV2.safeParse(raw);
    if (!parsed.success) return validationFailureV1('board_document_get', requestId, parsed.error);
    const result =
      parsed.data.revisionId === null
        ? await this.gateway.call((client) =>
            client.getDocumentBoard(
              {
                protocolVersion: 1,
                requestId: requestId as RequestId,
                type: 'board.get',
                boardId: parsed.data.boardId as BoardId,
              },
              signal,
            ),
          )
        : await this.gateway.call((client) =>
            client.getDocumentHistory(
              {
                protocolVersion: 1,
                requestId: requestId as RequestId,
                type: 'history.get',
                boardId: parsed.data.boardId as BoardId,
                revisionId: parsed.data.revisionId as RevisionId,
              },
              signal,
            ),
          );
    if (!result.connected) return disconnected('board_document_get', requestId);
    if (!result.value.ok)
      return sdkToolResultV1('board_document_get', requestId, result.value, null);
    const nested = result.value.result.result;
    const snapshot =
      nested.type === 'board.get'
        ? nested.snapshot
        : nested.type === 'history.get'
          ? nested.snapshot
          : null;
    if (snapshot === null) throw new Error('document get result invariant failed');
    if (!('document' in snapshot))
      return mismatch('board_document_get', requestId, 'document.replace');
    return sdkToolResultV1(
      'board_document_get',
      requestId,
      result.value,
      nested.type === 'history.get'
        ? { type: 'history', history: result.value.metadata.history }
        : null,
    );
  }

  replace(raw: unknown, signal?: AbortSignal): Promise<CallToolResult> {
    return this.mutate(
      'board_document_replace',
      DocumentReplaceInputSchemaV2,
      raw,
      (value) => ({
        type: 'document.replace',
        document: value.document as never,
      }),
      signal,
    );
  }

  add(raw: unknown, signal?: AbortSignal): Promise<CallToolResult> {
    return this.mutate(
      'board_page_add',
      PageAddInputSchemaV2,
      raw,
      (value) => ({
        type: 'page.add',
        page: value.page as never,
        index: value.index as number,
      }),
      signal,
    );
  }

  remove(raw: unknown, signal?: AbortSignal): Promise<CallToolResult> {
    return this.mutate(
      'board_page_remove',
      PageRemoveInputSchemaV2,
      raw,
      (value) => ({ type: 'page.remove', pageId: value.pageId as PageId }),
      signal,
    );
  }

  reorder(raw: unknown, signal?: AbortSignal): Promise<CallToolResult> {
    return this.mutate(
      'board_page_reorder',
      PageReorderInputSchemaV2,
      raw,
      (value) => ({
        type: 'page.reorder',
        pageId: value.pageId as PageId,
        toIndex: value.toIndex as number,
      }),
      signal,
    );
  }

  update(raw: unknown, signal?: AbortSignal): Promise<CallToolResult> {
    return this.mutate(
      'board_page_update',
      PageUpdateInputSchemaV2,
      raw,
      (value) => ({
        type: 'page.update',
        pageId: value.pageId as PageId,
        ...(Object.hasOwn(value, 'title') ? { title: value.title as string } : {}),
        ...(Object.hasOwn(value, 'displayMode')
          ? { displayMode: value.displayMode as PageDisplayModeV1 }
          : {}),
        ...(Object.hasOwn(value, 'scene') ? { scene: value.scene as never } : {}),
      }),
      signal,
    );
  }

  defaultSet(raw: unknown, signal?: AbortSignal): Promise<CallToolResult> {
    return this.mutate(
      'board_page_default_set',
      PageDefaultSetInputSchemaV2,
      raw,
      (value) => ({ type: 'page.default.set', pageId: value.pageId as PageId }),
      signal,
    );
  }

  private async mutate(
    tool: DocumentMutationTool,
    schema: z.ZodTypeAny,
    raw: unknown,
    operation: (value: Record<string, unknown>) => DocumentTransformOperationV2,
    signal?: AbortSignal,
  ): Promise<CallToolResult> {
    const requestId = createRequestIdV1();
    const parsed = schema.safeParse(raw);
    if (!parsed.success) return validationFailureV1(tool, requestId, parsed.error);
    const value = parsed.data as Record<string, unknown>;
    const head = await this.gateway.call((client) =>
      client.getDocumentBoard(
        {
          protocolVersion: 1,
          requestId: requestId as RequestId,
          type: 'board.get',
          boardId: value.boardId as BoardId,
        },
        signal,
      ),
    );
    if (!head.connected) return disconnected(tool, requestId);
    if (!head.value.ok) return sdkToolResultV1(tool, requestId, head.value, null);
    const nested = head.value.result.result;
    if (nested.type !== 'board.get') throw new Error('board.get result invariant failed');
    if (!('document' in nested.snapshot)) return mismatch(tool, requestId, 'document.replace');
    if (nested.snapshot.revision.revisionId !== value.expectedRevisionId)
      return toolFailureV1(tool, requestId, 'board', {
        protocolVersion: 1,
        type: 'board.error',
        code: 'REVISION_CONFLICT',
        message: 'Revision conflict',
        category: 'conflict',
        retryable: false,
        httpStatusHint: 409,
        details: {
          boardId: value.boardId,
          expectedRevisionId: value.expectedRevisionId,
          actualRevisionId: nested.snapshot.revision.revisionId,
          actualRevisionNumber: nested.snapshot.revision.revisionNumber,
          recovery: 'fetch_latest_then_retry',
        },
      });
    const source = BoardDocumentParserV2.parse(nested.snapshot.document);
    if (!source.ok)
      return toolFailureV1(
        tool,
        requestId,
        'board',
        source.error as unknown as Record<string, unknown>,
      );
    const transformed = applyDocumentTransformV2(source.data.value, operation(value));
    if (!transformed.ok)
      return toolFailureV1(
        tool,
        requestId,
        'board',
        transformed.error as unknown as Record<string, unknown>,
      );
    const result = await this.gateway.call((client) =>
      client.mutateDocument(
        {
          protocolVersion: 1,
          requestId: requestId as RequestId,
          boardId: value.boardId as BoardId,
          expectedRevisionId: value.expectedRevisionId as RevisionId,
          idempotencyKey: value.idempotencyKey as IdempotencyKey,
          command: { type: 'document.replace', document: transformed.data.value },
        },
        signal,
      ),
    );
    return result.connected
      ? sdkToolResultV1(tool, requestId, result.value, null)
      : disconnected(tool, requestId);
  }
}
