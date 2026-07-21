import {
  BoardApiTransport,
  operationRequest,
  parseHitlLifecycleRequest,
  parseHitlMutationRequest,
} from './board-api-core';
import type {
  ApiResult,
  HitlCancelAdapterRequest,
  HitlLifecycleResult,
  HitlReadOperationRequest,
  HitlReadResult,
  HitlRequestMutationRequest,
  HitlRequestResult,
  HitlRespondMutationRequest,
  HitlRespondResult,
  HitlSupersedeAdapterRequest,
} from './board-api-types';

export class BoardHitlApi extends BoardApiTransport {
  async requestInteraction(
    requestValue: HitlRequestMutationRequest,
    signal?: AbortSignal,
  ): Promise<ApiResult<HitlRequestResult>> {
    const request = parseHitlMutationRequest(requestValue, 'hitl.request');
    return this.writeMutation(request, signal) as Promise<ApiResult<HitlRequestResult>>;
  }

  async respondToInteraction(
    requestValue: HitlRespondMutationRequest,
    signal?: AbortSignal,
  ): Promise<ApiResult<HitlRespondResult>> {
    const request = parseHitlMutationRequest(requestValue, 'hitl.respond');
    return this.writeMutation(request, signal) as Promise<ApiResult<HitlRespondResult>>;
  }

  async readInteraction(
    requestValue: HitlReadOperationRequest,
    signal?: AbortSignal,
  ): Promise<ApiResult<HitlReadResult>> {
    const request = operationRequest<'hitl.read'>(requestValue);
    const query = new URLSearchParams({ requestId: request.requestId });
    if (request.wait !== null) {
      query.set('afterStateUpdatedAt', request.wait.afterStateUpdatedAt);
      query.set('timeoutMs', String(request.wait.timeoutMs));
    }
    return this.readOperation(
      `/api/v1/boards/${encodeURIComponent(request.boardId)}/interactions/${encodeURIComponent(request.hitlRequestId)}?${query.toString()}`,
      request,
      signal,
    );
  }

  async cancelInteraction(
    boardIdValue: string,
    hitlRequestIdValue: string,
    requestValue: HitlCancelAdapterRequest,
    signal?: AbortSignal,
  ): Promise<ApiResult<HitlLifecycleResult>> {
    const parsed = parseHitlLifecycleRequest(
      boardIdValue,
      hitlRequestIdValue,
      requestValue,
      'cancel',
    );
    return this.writeLifecycle(
      parsed.boardId,
      parsed.hitlRequestId,
      parsed.request,
      'cancel',
      signal,
    );
  }

  async supersedeInteraction(
    boardIdValue: string,
    hitlRequestIdValue: string,
    requestValue: HitlSupersedeAdapterRequest,
    signal?: AbortSignal,
  ): Promise<ApiResult<HitlLifecycleResult>> {
    const parsed = parseHitlLifecycleRequest(
      boardIdValue,
      hitlRequestIdValue,
      requestValue,
      'supersede',
    );
    return this.writeLifecycle(
      parsed.boardId,
      parsed.hitlRequestId,
      parsed.request,
      'supersede',
      signal,
    );
  }
}
