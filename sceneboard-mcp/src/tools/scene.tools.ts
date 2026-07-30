import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import {
  SceneParserV1,
  type BoardId,
  type IdempotencyKey,
  type RequestId,
  type RevisionId,
} from '@sceneboard/board-schema';
import {
  applySceneTransformV1,
  type SceneTransformOperationV1,
} from '@sceneboard/board-sdk/scene-transform';

import { ProtectedBoardGatewayV1 } from './protected-board.gateway.js';
import {
  createRequestIdV1,
  GlobalIdSchemaV1,
  IdempotencyKeySchemaV1,
  SceneTransformOperationSchemaV1,
} from './tool-schemas.js';
import {
  notConnectedV1,
  sdkToolResultV1,
  toolFailureV1,
  validationFailureV1,
} from './tool-result.js';

export const SceneGetInputSchemaV1 = z
  .object({ boardId: GlobalIdSchemaV1, revisionId: GlobalIdSchemaV1.nullable() })
  .strict();
export const SceneReplaceInputSchemaV1 = z
  .object({
    boardId: GlobalIdSchemaV1,
    expectedRevisionId: GlobalIdSchemaV1,
    idempotencyKey: IdempotencyKeySchemaV1,
    scene: z.unknown(),
  })
  .strict();
export const ScenePatchInputSchemaV1 = z
  .object({
    boardId: GlobalIdSchemaV1,
    expectedRevisionId: GlobalIdSchemaV1,
    idempotencyKey: IdempotencyKeySchemaV1,
    operations: z.array(SceneTransformOperationSchemaV1).min(1).max(1_000),
  })
  .strict();
export const SceneClearInputSchemaV1 = z
  .object({
    boardId: GlobalIdSchemaV1,
    expectedRevisionId: GlobalIdSchemaV1,
    idempotencyKey: IdempotencyKeySchemaV1,
  })
  .strict();

const documentMismatch = (
  tool: 'board_scene_get' | 'board_scene_patch',
  requestId: string,
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
      headSchemaVersion: 2,
      commandSchemaVersion: 1,
      commandType: 'scene.replace',
    },
  });

export class SceneToolHandlersV1 {
  constructor(private readonly gateway: ProtectedBoardGatewayV1) {}

  async get(raw: unknown, signal?: AbortSignal): Promise<CallToolResult> {
    const requestId = createRequestIdV1();
    const parsed = SceneGetInputSchemaV1.safeParse(raw);
    if (!parsed.success) return validationFailureV1('board_scene_get', requestId, parsed.error);
    if (parsed.data.revisionId === null) {
      const result = await this.gateway.call('board_scene_get', 'board.get', (client) =>
        client.getBoard(
          {
            protocolVersion: 1,
            requestId: requestId as RequestId,
            type: 'board.get',
            boardId: parsed.data.boardId as BoardId,
          },
          signal,
        ),
      );
      if (
        result.connected &&
        result.value.ok &&
        result.value.result.result.type === 'board.get' &&
        'document' in result.value.result.result.snapshot
      )
        return documentMismatch('board_scene_get', requestId);
      return result.connected
        ? sdkToolResultV1('board_scene_get', requestId, result.value, null)
        : toolFailureV1(
            'board_scene_get',
            requestId,
            'mcp',
            notConnectedV1() as unknown as Record<string, unknown>,
          );
    }
    const result = await this.gateway.call('board_scene_get', 'board.get', (client) =>
      client.getHistory(
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
    if (
      result.connected &&
      result.value.ok &&
      result.value.result.result.type === 'history.get' &&
      'document' in result.value.result.result.snapshot
    )
      return documentMismatch('board_scene_get', requestId);
    return result.connected
      ? sdkToolResultV1(
          'board_scene_get',
          requestId,
          result.value,
          result.value.ok ? { type: 'history', history: result.value.metadata.history } : null,
        )
      : toolFailureV1(
          'board_scene_get',
          requestId,
          'mcp',
          notConnectedV1() as unknown as Record<string, unknown>,
        );
  }

  async replace(raw: unknown, signal?: AbortSignal): Promise<CallToolResult> {
    const requestId = createRequestIdV1();
    const parsed = SceneReplaceInputSchemaV1.safeParse(raw);
    if (!parsed.success) return validationFailureV1('board_scene_replace', requestId, parsed.error);
    const scene = SceneParserV1.parse(parsed.data.scene);
    if (!scene.ok)
      return toolFailureV1(
        'board_scene_replace',
        requestId,
        'board',
        scene.error as unknown as Record<string, unknown>,
      );
    const result = await this.gateway.call('board_scene_replace', 'scene.replace', (client) =>
      client.mutateBoard(
        {
          protocolVersion: 1,
          requestId: requestId as RequestId,
          boardId: parsed.data.boardId as BoardId,
          expectedRevisionId: parsed.data.expectedRevisionId as RevisionId,
          idempotencyKey: parsed.data.idempotencyKey as IdempotencyKey,
          command: { type: 'scene.replace', scene: scene.data.value },
        },
        signal,
      ),
    );
    return result.connected
      ? sdkToolResultV1('board_scene_replace', requestId, result.value, null)
      : toolFailureV1(
          'board_scene_replace',
          requestId,
          'mcp',
          notConnectedV1() as unknown as Record<string, unknown>,
        );
  }

  async patch(raw: unknown, signal?: AbortSignal): Promise<CallToolResult> {
    const requestId = createRequestIdV1();
    const parsed = ScenePatchInputSchemaV1.safeParse(raw);
    if (!parsed.success) return validationFailureV1('board_scene_patch', requestId, parsed.error);
    const head = await this.gateway.call('board_scene_patch', 'scene.replace', (client) =>
      client.getBoard(
        {
          protocolVersion: 1,
          requestId: requestId as RequestId,
          type: 'board.get',
          boardId: parsed.data.boardId as BoardId,
        },
        signal,
      ),
    );
    if (!head.connected)
      return toolFailureV1(
        'board_scene_patch',
        requestId,
        'mcp',
        notConnectedV1() as unknown as Record<string, unknown>,
      );
    if (!head.value.ok) return sdkToolResultV1('board_scene_patch', requestId, head.value, null);
    const snapshot = head.value.result.result;
    if (snapshot.type !== 'board.get') throw new Error('board.get result invariant failed');
    if ('document' in snapshot.snapshot) return documentMismatch('board_scene_patch', requestId);
    const transformed = applySceneTransformV1(
      snapshot.snapshot.scene,
      parsed.data.operations as SceneTransformOperationV1[],
    );
    if (!transformed.ok)
      return toolFailureV1(
        'board_scene_patch',
        requestId,
        'board',
        transformed.error as unknown as Record<string, unknown>,
      );
    const result = await this.gateway.call('board_scene_patch', 'scene.replace', (client) =>
      client.mutateBoard(
        {
          protocolVersion: 1,
          requestId: requestId as RequestId,
          boardId: parsed.data.boardId as BoardId,
          expectedRevisionId: parsed.data.expectedRevisionId as RevisionId,
          idempotencyKey: parsed.data.idempotencyKey as IdempotencyKey,
          command: { type: 'scene.replace', scene: transformed.data.value },
        },
        signal,
      ),
    );
    return result.connected
      ? sdkToolResultV1('board_scene_patch', requestId, result.value, {
          type: 'scene-transform',
          transformedFromRevisionId: snapshot.snapshot.revision.revisionId,
        })
      : toolFailureV1(
          'board_scene_patch',
          requestId,
          'mcp',
          notConnectedV1() as unknown as Record<string, unknown>,
        );
  }

  async clear(raw: unknown, signal?: AbortSignal): Promise<CallToolResult> {
    const requestId = createRequestIdV1();
    const parsed = SceneClearInputSchemaV1.safeParse(raw);
    if (!parsed.success) return validationFailureV1('board_scene_clear', requestId, parsed.error);
    const result = await this.gateway.call('board_scene_clear', 'scene.clear', (client) =>
      client.mutateBoard(
        {
          protocolVersion: 1,
          requestId: requestId as RequestId,
          boardId: parsed.data.boardId as BoardId,
          expectedRevisionId: parsed.data.expectedRevisionId as RevisionId,
          idempotencyKey: parsed.data.idempotencyKey as IdempotencyKey,
          command: { type: 'scene.clear' },
        },
        signal,
      ),
    );
    return result.connected
      ? sdkToolResultV1('board_scene_clear', requestId, result.value, null)
      : toolFailureV1(
          'board_scene_clear',
          requestId,
          'mcp',
          notConnectedV1() as unknown as Record<string, unknown>,
        );
  }
}
