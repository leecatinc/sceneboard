import {
  BOARD_LIMITS_V1,
  BoardErrorParserV1,
  type PageCursorV1,
  type TimestampV1,
} from '@sceneboard/board-schema';

import {
  BoardApiTransport,
  createPublicId,
  exactKeys,
  hasNoStore,
  isObject,
  operationRequest,
  parseBoardId,
  parseRevisionId,
} from './board-api-core';
import type {
  ApiResult,
  ArchiveBoardInput,
  BoardArchiveResult,
  BoardCapabilitiesResult,
  BoardCreateResult,
  BoardGetResult,
  BoardListResult,
  BoardRenameResult,
  CreateBoardInput,
  HistoryGetResult,
  HistoryListResult,
} from './board-api-types';

export class BoardResourceApi extends BoardApiTransport {
  async listBoards(
    cursor: PageCursorV1 | null = null,
    signal?: AbortSignal,
  ): Promise<ApiResult<BoardListResult>> {
    const request = operationRequest<'board.list'>({
      protocolVersion: 1,
      requestId: createPublicId('req'),
      type: 'board.list',
      cursor,
      limit: 50,
      includeArchived: false,
    });
    const query = new URLSearchParams({
      requestId: request.requestId,
      limit: String(request.limit),
      includeArchived: 'false',
    });
    if (request.cursor !== null) query.set('cursor', request.cursor);
    return this.readOperation(`/api/v1/boards?${query.toString()}`, request, signal);
  }

  async createBoard(input: CreateBoardInput): Promise<ApiResult<BoardCreateResult>> {
    const request = operationRequest<'board.create'>({
      protocolVersion: 1,
      requestId: input.requestId,
      type: 'board.create',
      idempotencyKey: input.idempotencyKey,
      title: input.title,
    });
    return this.writeOperation('/api/v1/boards', request, input.csrfToken, input.signal);
  }

  async getBoard(boardIdValue: string, signal?: AbortSignal): Promise<ApiResult<BoardGetResult>> {
    const boardId = parseBoardId(boardIdValue);
    const request = operationRequest<'board.get'>({
      protocolVersion: 1,
      requestId: createPublicId('req'),
      type: 'board.get',
      boardId,
    });
    const query = new URLSearchParams({
      requestId: request.requestId,
      documentSchemaVersion: '3',
    });
    return this.readOperation(
      `/api/v1/boards/${encodeURIComponent(boardId)}?${query.toString()}`,
      request,
      signal,
      3,
    );
  }

  async getCapabilities(
    boardIdValue: string,
    signal?: AbortSignal,
  ): Promise<ApiResult<BoardCapabilitiesResult>> {
    const boardId = parseBoardId(boardIdValue);
    const request = operationRequest<'capabilities.get'>({
      protocolVersion: 1,
      requestId: createPublicId('req'),
      type: 'capabilities.get',
      boardId,
    });
    const query = new URLSearchParams({
      requestId: request.requestId,
      documentSchemaVersion: '3',
    });
    return this.readOperation(
      `/api/v1/boards/${encodeURIComponent(boardId)}/capabilities?${query.toString()}`,
      request,
      signal,
    );
  }

  async archiveBoard(input: ArchiveBoardInput): Promise<ApiResult<BoardArchiveResult>> {
    const boardId = parseBoardId(input.boardId);
    const csrfToken = this.coordinator.currentSnapshot()?.csrfToken;
    if (csrfToken === undefined) return { kind: 'reconciliation_required' };
    const request = operationRequest<'board.archive'>({
      protocolVersion: 1,
      requestId: input.requestId,
      type: 'board.archive',
      idempotencyKey: input.idempotencyKey,
      boardId,
      confirm: true,
    });
    return this.writeOperation(
      `/api/v1/boards/${encodeURIComponent(boardId)}/archive`,
      request,
      csrfToken,
      input.signal,
    );
  }

  async renameBoard(
    boardIdValue: string,
    titleValue: string,
    signal?: AbortSignal,
  ): Promise<ApiResult<BoardRenameResult>> {
    const boardId = parseBoardId(boardIdValue);
    const title = titleValue.trim();
    if (
      title !== titleValue ||
      title.length === 0 ||
      [...title].length > BOARD_LIMITS_V1.maxTitleChars
    ) {
      throw new TypeError('invalid board title');
    }
    const csrfToken = this.coordinator.currentSnapshot()?.csrfToken;
    if (csrfToken === undefined) return { kind: 'reconciliation_required' };
    const result = await this.coordinator.dispatchShared({
      path: `/api/v1/boards/${encodeURIComponent(boardId)}/title`,
      method: 'POST',
      body: { title },
      csrfToken,
      ...(signal === undefined ? {} : { signal }),
    });
    if (result.kind !== 'ok') return result;
    const { response, body } = result.value;
    if (!response.ok) {
      if (isObject(body) && exactKeys(body, ['error'])) {
        const error = BoardErrorParserV1.parse(body.error);
        if (error.ok && error.data.value.httpStatusHint === response.status) {
          return { kind: 'board_error', error: error.data.value };
        }
      }
      return { kind: 'api_error', status: response.status };
    }
    const cacheControl = response.headers.get('cache-control');
    if (
      response.status !== 200 ||
      response.redirected ||
      response.headers.get('content-type')?.toLowerCase() !== 'application/json; charset=utf-8' ||
      !hasNoStore(cacheControl) ||
      !isObject(body) ||
      !exactKeys(body, ['boardId', 'title', 'updatedAt']) ||
      body.boardId !== boardId ||
      body.title !== title ||
      typeof body.updatedAt !== 'string' ||
      new Date(body.updatedAt).toISOString() !== body.updatedAt
    )
      return { kind: 'corrupt_response' };
    return {
      kind: 'ok',
      value: { boardId, title, updatedAt: body.updatedAt as TimestampV1 },
    };
  }

  async listHistory(
    boardIdValue: string,
    cursor: PageCursorV1 | null = null,
    signal?: AbortSignal,
  ): Promise<ApiResult<HistoryListResult>> {
    const boardId = parseBoardId(boardIdValue);
    const request = operationRequest<'history.list'>({
      protocolVersion: 1,
      requestId: createPublicId('req'),
      type: 'history.list',
      boardId,
      cursor,
      limit: 50,
    });
    const query = new URLSearchParams({
      requestId: request.requestId,
      limit: String(request.limit),
      documentSchemaVersion: '3',
    });
    if (request.cursor !== null) query.set('cursor', request.cursor);
    const result = await this.readOperation(
      `/api/v1/boards/${encodeURIComponent(boardId)}/revisions?${query.toString()}`,
      request,
      signal,
      3,
    );
    if (result.kind !== 'ok') return result;
    if (result.value.metadata === null) return { kind: 'corrupt_response' };
    return { kind: 'ok', value: { ...result.value.result, metadata: result.value.metadata } };
  }

  async getHistoryRevision(
    boardIdValue: string,
    revisionIdValue: string,
    signal?: AbortSignal,
  ): Promise<ApiResult<HistoryGetResult>> {
    const boardId = parseBoardId(boardIdValue);
    const revisionId = parseRevisionId(revisionIdValue);
    const request = operationRequest<'history.get'>({
      protocolVersion: 1,
      requestId: createPublicId('req'),
      type: 'history.get',
      boardId,
      revisionId,
    });
    const query = new URLSearchParams({
      requestId: request.requestId,
      documentSchemaVersion: '3',
    });
    const result = await this.readOperation(
      `/api/v1/boards/${encodeURIComponent(boardId)}/revisions/${encodeURIComponent(revisionId)}?${query.toString()}`,
      request,
      signal,
      3,
    );
    if (result.kind !== 'ok') return result;
    if (result.value.metadata === null) return { kind: 'corrupt_response' };
    return { kind: 'ok', value: { ...result.value.result, metadata: result.value.metadata } };
  }
}
