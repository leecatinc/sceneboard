import {
  ArtifactReferenceParserV1,
  BoardErrorParserV1,
  BoardIdParserV1,
  BoardOperationRequestParserV1,
  GlobalIdStringParserV1,
  HitlInteractionParserV1,
  MutationRequestParserV1,
  canonicalizeJsonV1,
  type ArtifactReferenceV1,
  type BoardId,
  type BoardOperationRequestV1,
  type HitlRequestId,
  type RequestId,
  type RevisionId,
  type TimestampV1,
} from '@sceneboard/board-schema';
import { parseBoardHttpResultV1, type HistoryAdapterMetadataV1 } from '@sceneboard/board-sdk/http';

import type { SessionRequestCoordinator } from '../auth/renewal-singleflight';
import type {
  ApiResult,
  HitlCancelAdapterRequest,
  HitlLifecycleResult,
  HitlMutationRequest,
  HitlMutationResult,
  HitlSupersedeAdapterRequest,
  MutationRequest,
  OperationData,
  OperationRequest,
} from './board-api-types';

export class BoardApiTransport {
  constructor(protected readonly coordinator: SessionRequestCoordinator) {}

  protected async emptyMutation(
    path: string,
    method: 'DELETE',
    csrfToken: string,
  ): Promise<ApiResult<null>> {
    const result = await this.coordinator.dispatchShared({ path, method, csrfToken });
    if (result.kind !== 'ok') return result;
    return result.value.response.status === 204
      ? { kind: 'ok', value: null }
      : { kind: 'api_error', status: result.value.response.status };
  }

  protected async readOperation<
    K extends
      | 'board.list'
      | 'board.get'
      | 'history.list'
      | 'history.get'
      | 'artifact.get'
      | 'hitl.read',
  >(
    path: string,
    request: OperationRequest<K>,
    signal?: AbortSignal,
  ): Promise<
    ApiResult<
      K extends 'history.list' | 'history.get'
        ? { result: OperationData<K>; metadata: HistoryAdapterMetadataV1 | null }
        : OperationData<K>
    >
  > {
    const result = await this.coordinator.dispatchShared({
      path,
      method: 'GET',
      ...(signal === undefined ? {} : { signal }),
    });
    return this.decodeOperation(result, request) as ApiResult<
      K extends 'history.list' | 'history.get'
        ? { result: OperationData<K>; metadata: HistoryAdapterMetadataV1 | null }
        : OperationData<K>
    >;
  }

  protected async writeMutation(
    request: HitlMutationRequest,
    signal?: AbortSignal,
  ): Promise<ApiResult<HitlMutationResult>> {
    const csrfToken = this.coordinator.currentSnapshot()?.csrfToken;
    if (csrfToken === undefined) return { kind: 'reconciliation_required' };
    const result = await this.coordinator.dispatchShared({
      path: `/api/v1/boards/${encodeURIComponent(request.boardId)}/mutations`,
      method: 'POST',
      body: request,
      csrfToken,
      ...(signal === undefined ? {} : { signal }),
    });
    return this.decodeMutation(result, request);
  }

  protected async writeLifecycle(
    boardId: BoardId,
    hitlRequestId: HitlRequestId,
    request: HitlCancelAdapterRequest | HitlSupersedeAdapterRequest,
    action: 'cancel' | 'supersede',
    signal?: AbortSignal,
  ): Promise<ApiResult<HitlLifecycleResult>> {
    const csrfToken = this.coordinator.currentSnapshot()?.csrfToken;
    if (csrfToken === undefined) return { kind: 'reconciliation_required' };
    const result = await this.coordinator.dispatchShared({
      path: `/api/v1/boards/${encodeURIComponent(boardId)}/interactions/${encodeURIComponent(hitlRequestId)}/${action}`,
      method: 'POST',
      body: request,
      csrfToken,
      ...(signal === undefined ? {} : { signal }),
    });
    return decodeLifecycle(result, {
      requestId: request.requestId,
      boardId,
      hitlRequestId,
      action,
    });
  }

  protected async writeOperation<K extends 'board.create' | 'board.archive'>(
    path: string,
    request: OperationRequest<K>,
    csrfToken: string,
    signal?: AbortSignal,
  ): Promise<ApiResult<OperationData<K>>> {
    const result = await this.coordinator.dispatchShared({
      path,
      method: 'POST',
      body: request,
      csrfToken,
      ...(signal === undefined ? {} : { signal }),
    });
    return this.decodeOperation(result, request) as ApiResult<OperationData<K>>;
  }

  private decodeOperation<
    K extends
      | 'board.list'
      | 'board.get'
      | 'board.create'
      | 'board.archive'
      | 'history.list'
      | 'history.get'
      | 'artifact.get'
      | 'hitl.read',
  >(
    result: Awaited<ReturnType<SessionRequestCoordinator['dispatchShared']>>,
    request: OperationRequest<K>,
  ): ApiResult<
    OperationData<K> | { result: OperationData<K>; metadata: HistoryAdapterMetadataV1 | null }
  > {
    if (result.kind !== 'ok') return result;
    const { response, bytes } = result.value;
    const cacheControl =
      response.headers
        .get('cache-control')
        ?.split(',')
        .map((part) => part.trim().toLowerCase()) ?? [];
    if (
      response.redirected ||
      (response.status >= 300 && response.status < 400) ||
      response.headers.get('content-type')?.toLowerCase() !== 'application/json; charset=utf-8' ||
      !cacheControl.includes('no-store') ||
      response.headers.get('x-request-id') !== request.requestId
    )
      return { kind: 'corrupt_response' };
    const parsed = parseBoardHttpResultV1(bytes, {
      status: response.status,
      requestId: request.requestId,
      resultType: request.type,
      ...('boardId' in request ? { boardId: request.boardId } : {}),
      ...(request.type === 'artifact.get' ? { artifact: request.artifact } : {}),
      ...(request.type === 'history.get' ? { revisionId: request.revisionId } : {}),
    });
    if (!parsed.ok) return { kind: 'corrupt_response' };
    if (!parsed.value.ok) return { kind: 'board_error', error: parsed.value.error };
    const operation = parsed.value.value.result;
    if (operation.type !== 'board.operation.result' || operation.result.type !== request.type) {
      return { kind: 'corrupt_response' };
    }
    const value = operation.result as OperationData<K>;
    if (
      request.type === 'hitl.read' &&
      (value.type !== 'hitl.read' || value.hitl.hitlRequestId !== request.hitlRequestId)
    ) {
      return { kind: 'corrupt_response' };
    }
    return request.type === 'history.list' || request.type === 'history.get'
      ? { kind: 'ok', value: { result: value, metadata: parsed.value.value.metadata.history } }
      : { kind: 'ok', value };
  }

  private decodeMutation(
    result: Awaited<ReturnType<SessionRequestCoordinator['dispatchShared']>>,
    request: HitlMutationRequest,
  ): ApiResult<HitlMutationResult> {
    if (result.kind !== 'ok') return result;
    const { response, bytes } = result.value;
    if (!validJsonResponse(response, request.requestId)) return { kind: 'corrupt_response' };
    const parsed = parseBoardHttpResultV1(bytes, {
      status: response.status,
      requestId: request.requestId,
      resultType: request.command.type,
      boardId: request.boardId,
    });
    if (!parsed.ok) return { kind: 'corrupt_response' };
    if (!parsed.value.ok) return { kind: 'board_error', error: parsed.value.error };
    const resultEnvelope = parsed.value.value.result;
    if (
      resultEnvelope.type !== 'mutation.result' ||
      (resultEnvelope.result.type !== 'hitl.request' &&
        resultEnvelope.result.type !== 'hitl.respond') ||
      resultEnvelope.result.type !== request.command.type ||
      resultEnvelope.result.hitl.hitlRequestId !== request.command.hitlRequestId
    ) {
      return { kind: 'corrupt_response' };
    }
    const expected =
      request.command.type === 'hitl.request' ? request.command.request : request.command.response;
    const actual =
      request.command.type === 'hitl.request'
        ? resultEnvelope.result.hitl.definition
        : resultEnvelope.result.hitl.response;
    if (!sameCanonicalValue(expected, actual)) return { kind: 'corrupt_response' };
    return { kind: 'ok', value: resultEnvelope.result };
  }
}

export const createPublicId = (prefix: string): RequestId => {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `${prefix}_${btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')}` as RequestId;
};

export const operationRequest = <K extends BoardOperationRequestV1['type']>(
  value: OperationRequest<K>,
): OperationRequest<K> => {
  const parsed = BoardOperationRequestParserV1.parse(value);
  if (!parsed.ok || parsed.data.value.type !== value.type)
    throw new TypeError(`invalid ${value.type} request`);
  return parsed.data.value as OperationRequest<K>;
};

export const parseBoardId = (value: string): BoardId => {
  const parsed = BoardIdParserV1.parse(value);
  if (!parsed.ok) throw new TypeError('invalid board ID');
  return parsed.data.value;
};

export const parseRevisionId = (value: string): RevisionId => {
  const parsed = GlobalIdStringParserV1.parse(value);
  if (!parsed.ok) throw new TypeError('invalid revision ID');
  return parsed.data.value as RevisionId;
};

export const parseArtifactReference = (value: ArtifactReferenceV1): ArtifactReferenceV1 => {
  const parsed = ArtifactReferenceParserV1.parse(value);
  if (!parsed.ok) throw new TypeError('invalid artifact reference');
  return parsed.data.value;
};

export const parseHitlMutationRequest = <K extends 'hitl.request' | 'hitl.respond'>(
  value: MutationRequest<K>,
  kind: K,
): MutationRequest<K> => {
  const parsed = MutationRequestParserV1.parse(value);
  if (!parsed.ok || parsed.data.value.command.type !== kind)
    throw new TypeError(`invalid ${kind} request`);
  return parsed.data.value as MutationRequest<K>;
};

export const parseHitlLifecycleRequest = <K extends 'cancel' | 'supersede'>(
  boardIdValue: string,
  hitlRequestIdValue: string,
  value: K extends 'cancel' ? HitlCancelAdapterRequest : HitlSupersedeAdapterRequest,
  action: K,
): {
  boardId: BoardId;
  hitlRequestId: HitlRequestId;
  request: K extends 'cancel' ? HitlCancelAdapterRequest : HitlSupersedeAdapterRequest;
} => {
  const allowed =
    action === 'cancel'
      ? ['protocolVersion', 'requestId', 'expectedRevisionId', 'expectedStateUpdatedAt']
      : [
          'protocolVersion',
          'requestId',
          'expectedRevisionId',
          'expectedStateUpdatedAt',
          'successorHitlRequestId',
        ];
  if (!isObject(value) || !exactKeys(value, allowed))
    throw new TypeError(`invalid hitl ${action} request`);
  const boardId = parseBoardId(boardIdValue);
  const hitlRead = operationRequest<'hitl.read'>({
    protocolVersion: 1,
    requestId: value.requestId,
    type: 'hitl.read',
    boardId,
    hitlRequestId: hitlRequestIdValue as HitlRequestId,
    wait: { afterStateUpdatedAt: value.expectedStateUpdatedAt, timeoutMs: 0 },
  } as OperationRequest<'hitl.read'>);
  const revisionProbe = MutationRequestParserV1.parse({
    protocolVersion: 1,
    requestId: value.requestId,
    idempotencyKey: 'hitl-lifecycle-v1',
    boardId,
    expectedRevisionId: value.expectedRevisionId,
    command: { type: 'scene.clear' },
  });
  if (!revisionProbe.ok) throw new TypeError(`invalid hitl ${action} request`);
  const request =
    action === 'cancel'
      ? {
          protocolVersion: 1 as const,
          requestId: hitlRead.requestId,
          expectedRevisionId: revisionProbe.data.value.expectedRevisionId,
          expectedStateUpdatedAt: hitlRead.wait?.afterStateUpdatedAt as TimestampV1,
        }
      : {
          protocolVersion: 1 as const,
          requestId: hitlRead.requestId,
          expectedRevisionId: revisionProbe.data.value.expectedRevisionId,
          expectedStateUpdatedAt: hitlRead.wait?.afterStateUpdatedAt as TimestampV1,
          successorHitlRequestId: operationRequest<'hitl.read'>({
            protocolVersion: 1,
            requestId: value.requestId,
            type: 'hitl.read',
            boardId,
            hitlRequestId: (value as HitlSupersedeAdapterRequest).successorHitlRequestId,
            wait: null,
          }).hitlRequestId,
        };
  return { boardId, hitlRequestId: hitlRead.hitlRequestId, request } as {
    boardId: BoardId;
    hitlRequestId: HitlRequestId;
    request: K extends 'cancel' ? HitlCancelAdapterRequest : HitlSupersedeAdapterRequest;
  };
};

export const validJsonResponse = (response: Response, requestId: RequestId): boolean => {
  const cacheControl =
    response.headers
      .get('cache-control')
      ?.split(',')
      .map((part) => part.trim().toLowerCase()) ?? [];
  return (
    !response.redirected &&
    !(response.status >= 300 && response.status < 400) &&
    response.headers.get('content-type')?.toLowerCase() === 'application/json; charset=utf-8' &&
    cacheControl.includes('no-store') &&
    response.headers.get('x-request-id') === requestId
  );
};

const sameCanonicalValue = (left: unknown, right: unknown): boolean => {
  const first = canonicalizeJsonV1(left);
  const second = canonicalizeJsonV1(right);
  if (
    !first.ok ||
    !second.ok ||
    first.data.canonicalBytes.byteLength !== second.data.canonicalBytes.byteLength
  )
    return false;
  return first.data.canonicalBytes.every(
    (byte, index) => byte === second.data.canonicalBytes[index],
  );
};

const decodeLifecycle = (
  result: Awaited<ReturnType<SessionRequestCoordinator['dispatchShared']>>,
  expected: {
    requestId: RequestId;
    boardId: BoardId;
    hitlRequestId: HitlRequestId;
    action: 'cancel' | 'supersede';
  },
): ApiResult<HitlLifecycleResult> => {
  if (result.kind !== 'ok') return result;
  const { response, bytes } = result.value;
  const strict = parseStrictJsonBytes(bytes);
  if (!validJsonResponse(response, expected.requestId) || !strict.ok || !isObject(strict.value))
    return { kind: 'corrupt_response' };
  const body = strict.value;
  if (Object.keys(body).length === 1 && Object.hasOwn(body, 'error')) {
    const error = BoardErrorParserV1.parse(body.error);
    return error.ok && error.data.value.httpStatusHint === response.status
      ? { kind: 'board_error', error: error.data.value }
      : { kind: 'corrupt_response' };
  }
  if (
    response.status !== 200 ||
    !exactKeys(body, [
      'protocolVersion',
      'type',
      'requestId',
      'boardId',
      'action',
      'replayed',
      'eventIds',
      'hitl',
    ]) ||
    body.protocolVersion !== 1 ||
    body.type !== 'hitl.lifecycle.result' ||
    body.requestId !== expected.requestId ||
    body.boardId !== expected.boardId ||
    body.action !== expected.action ||
    typeof body.replayed !== 'boolean' ||
    !Array.isArray(body.eventIds)
  )
    return { kind: 'corrupt_response' };
  const eventIds: string[] = [];
  for (const eventId of body.eventIds) {
    const parsed = GlobalIdStringParserV1.parse(eventId);
    if (!parsed.ok) return { kind: 'corrupt_response' };
    eventIds.push(parsed.data.value);
  }
  if (new Set(eventIds).size !== eventIds.length) return { kind: 'corrupt_response' };
  const hitl = HitlInteractionParserV1.parse(body.hitl);
  if (
    !hitl.ok ||
    hitl.data.value.hitlRequestId !== expected.hitlRequestId ||
    hitl.data.value.state !== (expected.action === 'cancel' ? 'cancelled' : 'superseded')
  ) {
    return { kind: 'corrupt_response' };
  }
  return {
    kind: 'ok',
    value: {
      protocolVersion: 1,
      type: 'hitl.lifecycle.result',
      requestId: expected.requestId,
      boardId: expected.boardId,
      action: expected.action,
      replayed: body.replayed,
      eventIds,
      hitl: hitl.data.value,
    },
  };
};

export const exactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
};

const parseStrictJsonBytes = (bytes: Uint8Array): { ok: true; value: unknown } | { ok: false } => {
  let source: string;
  try {
    source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return { ok: false };
  }
  type Frame = { kind: 'object'; keys: Set<string>; expectsKey: boolean } | { kind: 'array' };
  const stack: Frame[] = [];
  let inString = false;
  let escaped = false;
  let stringStart = 0;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') {
        inString = false;
        const frame = stack.at(-1);
        if (frame?.kind === 'object' && frame.expectsKey) {
          try {
            const key = JSON.parse(source.slice(stringStart, index + 1)) as unknown;
            if (typeof key === 'string') {
              if (frame.keys.has(key)) return { ok: false };
              frame.keys.add(key);
            }
          } catch {
            return { ok: false };
          }
        }
      }
      continue;
    }
    if (character === '"') {
      inString = true;
      stringStart = index;
    } else if (character === '{') stack.push({ kind: 'object', keys: new Set(), expectsKey: true });
    else if (character === '[') stack.push({ kind: 'array' });
    else if (character === '}' || character === ']') stack.pop();
    else if (character === ':') {
      const frame = stack.at(-1);
      if (frame?.kind === 'object') frame.expectsKey = false;
    } else if (character === ',') {
      const frame = stack.at(-1);
      if (frame?.kind === 'object') frame.expectsKey = true;
    }
  }
  try {
    return { ok: true, value: JSON.parse(source) as unknown };
  } catch {
    return { ok: false };
  }
};

export const hasNoStore = (value: string | null): boolean =>
  value !== null &&
  value
    .split(',')
    .map((part) => part.trim().toLowerCase())
    .includes('no-store');

export const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
