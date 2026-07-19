'use client';

import {
  ArtifactReferenceParserV1,
  BOARD_LIMITS_V1,
  BoardErrorParserV1,
  BoardIdParserV1,
  BoardOperationRequestParserV1,
  GlobalIdStringParserV1,
  HitlInteractionParserV1,
  MutationRequestParserV1,
  canonicalizeJsonV1,
  type BoardErrorV1,
  type ArtifactReferenceV1,
  type BoardId,
  type BoardOperationRequestV1,
  type BoardOperationResultDataV1,
  type ClientGrantCapabilityV1,
  type IdempotencyKey,
  type HitlRequestId,
  type HitlResponseV1,
  type MutationRequestV1,
  type MutationResultV1,
  type PageCursorV1,
  type RequestId,
  type RevisionId,
  type TimestampV1,
} from '@leecat-board/board-schema';
import {
  parseBoardHttpResultV1,
  type HistoryAdapterMetadataV1,
} from '@leecat-board/board-sdk/http';

import type { CoordinatorResult, SessionRequestCoordinator } from '../auth/renewal-singleflight';

export type LifecyclePermission = 'board.create' | 'board.archive';
export type PairingBoardDestination =
  | { mode: 'create'; title: string }
  | { mode: 'existing'; boardId: string }
  | { mode: 'deferred' };
export type PairingOwnerState = 'created' | 'pending' | 'approved' | 'redeemed' | 'denied' | 'cancelled' | 'expired' | 'locked';

export interface PairingOwnerStatus {
  pairingId: string;
  state: PairingOwnerState;
  createdAt: string;
  codeExpiresAt: string;
  decisionExpiresAt: string | null;
  redeemExpiresAt: string | null;
  client: { clientId: string; clientName: string; installationFingerprint: string } | null;
  requestedScopes: ClientGrantCapabilityV1[];
  requestedLifecyclePermissions: LifecyclePermission[];
  approvedScopes: ClientGrantCapabilityV1[] | null;
  approvedLifecyclePermissions: LifecyclePermission[] | null;
  boardIds: string[] | null;
  lifetime: 'session' | 'persistent' | null;
  decidedAt: string | null;
}

export interface GrantSummary {
  grantId: string;
  client: { clientId: string; clientName: string; installationFingerprint: string };
  scopes: ClientGrantCapabilityV1[];
  lifecyclePermissions: LifecyclePermission[];
  boardIds: string[];
  lifetime: 'session' | 'persistent';
  status: 'pending_redemption' | 'active' | 'revoked' | 'expired';
  createdAt: string;
  activatedAt: string | null;
  lastUsedAt: string | null;
  expiresAt: string;
  revokedAt: string | null;
}

export interface CreatedPairing {
  pairingId: string;
  code: string;
  state: 'created';
  codeExpiresAt: string;
}

export interface RotatedGrantCredential {
  tokenType: 'Bearer';
  accessToken: string;
  grant: GrantSummary;
}

export type ApiResult<Value> = CoordinatorResult<Value>
  | { kind: 'api_error'; status: number }
  | { kind: 'board_error'; error: BoardErrorV1 }
  | { kind: 'corrupt_response' };

type OperationRequest<K extends BoardOperationRequestV1['type']> = BoardOperationRequestV1 & { type: K };
type OperationData<K extends BoardOperationResultDataV1['type']> = BoardOperationResultDataV1 & { type: K };
type MutationRequest<K extends MutationRequestV1['command']['type']> = Omit<MutationRequestV1, 'command'> & {
  command: Extract<MutationRequestV1['command'], { type: K }>;
};
type MutationData<K extends MutationResultV1['result']['type']> = Extract<MutationResultV1['result'], { type: K }>;

export type BoardListResult = OperationData<'board.list'>;
export type BoardCreateResult = OperationData<'board.create'>;
export type BoardArchiveResult = OperationData<'board.archive'>;
export type BoardGetResult = OperationData<'board.get'>;
export type BoardRenameResult = { boardId: BoardId; title: string; updatedAt: TimestampV1 };
export type HistoryListResult = OperationData<'history.list'> & { metadata: HistoryAdapterMetadataV1 };
export type HistoryGetResult = OperationData<'history.get'> & { metadata: HistoryAdapterMetadataV1 };
export type ArtifactGetResult = OperationData<'artifact.get'>;
export type ArtifactPackageResult = { bytes: Uint8Array };
export type ArtifactNetworkResult = { bytes: Uint8Array };
export type HitlRequestResult = MutationData<'hitl.request'>;
export type HitlRespondResult = MutationData<'hitl.respond'>;
export type HitlReadResult = OperationData<'hitl.read'>;
export type HitlRequestMutationRequest = MutationRequest<'hitl.request'>;
export type HitlRespondMutationRequest = MutationRequest<'hitl.respond'>;
export type HitlReadOperationRequest = OperationRequest<'hitl.read'>;
export type HitlCancelAdapterRequest = {
  protocolVersion: 1;
  requestId: RequestId;
  expectedRevisionId: RevisionId;
  expectedStateUpdatedAt: TimestampV1;
};
export type HitlSupersedeAdapterRequest = HitlCancelAdapterRequest & {
  successorHitlRequestId: HitlRequestId;
};
type HitlMutationRequest = HitlRequestMutationRequest | HitlRespondMutationRequest;
type HitlMutationResult = HitlRequestResult | HitlRespondResult;
export type HitlLifecycleResult = {
  protocolVersion: 1;
  type: 'hitl.lifecycle.result';
  requestId: RequestId;
  boardId: BoardId;
  action: 'cancel' | 'supersede';
  replayed: boolean;
  eventIds: string[];
  hitl: HitlReadResult['hitl'];
};

export class BoardApiClient {
  constructor(private readonly coordinator: SessionRequestCoordinator) {}

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

  async createBoard(input: {
    title: string;
    requestId: RequestId;
    idempotencyKey: IdempotencyKey;
    csrfToken: string;
    signal?: AbortSignal;
  }): Promise<ApiResult<BoardCreateResult>> {
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
    const query = new URLSearchParams({ requestId: request.requestId });
    return this.readOperation(`/api/v1/boards/${encodeURIComponent(boardId)}?${query.toString()}`, request, signal);
  }

  async archiveBoard(
    input: {
      boardId: string;
      requestId: RequestId;
      idempotencyKey: IdempotencyKey;
      signal?: AbortSignal;
    },
  ): Promise<ApiResult<BoardArchiveResult>> {
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
    if (title !== titleValue || title.length === 0 || [...title].length > BOARD_LIMITS_V1.maxTitleChars) {
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
    if (response.status !== 200
      || response.redirected
      || response.headers.get('content-type')?.toLowerCase() !== 'application/json; charset=utf-8'
      || !hasNoStore(cacheControl)
      || !isObject(body)
      || !exactKeys(body, ['boardId', 'title', 'updatedAt'])
      || body.boardId !== boardId
      || body.title !== title
      || typeof body.updatedAt !== 'string'
      || new Date(body.updatedAt).toISOString() !== body.updatedAt) return { kind: 'corrupt_response' };
    return { kind: 'ok', value: { boardId, title, updatedAt: body.updatedAt as TimestampV1 } };
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
    const query = new URLSearchParams({ requestId: request.requestId, limit: String(request.limit) });
    if (request.cursor !== null) query.set('cursor', request.cursor);
    const result = await this.readOperation(
      `/api/v1/boards/${encodeURIComponent(boardId)}/revisions?${query.toString()}`,
      request,
      signal,
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
    const query = new URLSearchParams({ requestId: request.requestId });
    const result = await this.readOperation(
      `/api/v1/boards/${encodeURIComponent(boardId)}/revisions/${encodeURIComponent(revisionId)}?${query.toString()}`,
      request,
      signal,
    );
    if (result.kind !== 'ok') return result;
    if (result.value.metadata === null) return { kind: 'corrupt_response' };
    return { kind: 'ok', value: { ...result.value.result, metadata: result.value.metadata } };
  }

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
      boardIdValue, hitlRequestIdValue, requestValue, 'cancel',
    );
    return this.writeLifecycle(parsed.boardId, parsed.hitlRequestId, parsed.request, 'cancel', signal);
  }

  async supersedeInteraction(
    boardIdValue: string,
    hitlRequestIdValue: string,
    requestValue: HitlSupersedeAdapterRequest,
    signal?: AbortSignal,
  ): Promise<ApiResult<HitlLifecycleResult>> {
    const parsed = parseHitlLifecycleRequest(
      boardIdValue, hitlRequestIdValue, requestValue, 'supersede',
    );
    return this.writeLifecycle(parsed.boardId, parsed.hitlRequestId, parsed.request, 'supersede', signal);
  }

  async getArtifact(
    boardIdValue: string,
    artifactValue: ArtifactReferenceV1,
    signal?: AbortSignal,
  ): Promise<ApiResult<ArtifactGetResult>> {
    const boardId = parseBoardId(boardIdValue);
    const artifact = parseArtifactReference(artifactValue);
    const request = operationRequest<'artifact.get'>({
      protocolVersion: 1,
      requestId: createPublicId('req'),
      type: 'artifact.get',
      boardId,
      artifact,
    });
    const query = new URLSearchParams({ requestId: request.requestId });
    return this.readOperation(
      `/api/v1/boards/${encodeURIComponent(boardId)}/artifacts/${encodeURIComponent(artifact.artifactId)}/versions/${encodeURIComponent(artifact.versionId)}?${query.toString()}`,
      request,
      signal,
    );
  }

  async getArtifactPackage(
    boardIdValue: string,
    artifactValue: ArtifactReferenceV1,
    signal?: AbortSignal,
  ): Promise<ApiResult<ArtifactPackageResult>> {
    const boardId = parseBoardId(boardIdValue);
    const artifact = parseArtifactReference(artifactValue);
    const result = await this.coordinator.dispatchShared({
      path: `/api/v1/boards/${encodeURIComponent(boardId)}/artifacts/${encodeURIComponent(artifact.artifactId)}/versions/${encodeURIComponent(artifact.versionId)}/package`,
      method: 'GET',
      responseKind: 'artifact-package',
      ...(signal === undefined ? {} : { signal }),
    });
    if (result.kind !== 'ok') return result;
    const { response, bytes } = result.value;
    const vary = response.headers.get('vary')?.split(',').map((value) => value.trim().toLowerCase()).sort() ?? [];
    if (!response.ok
      || response.redirected
      || response.status !== 200
      || response.headers.get('content-type')?.toLowerCase() !== 'application/vnd.leecat.artifact-package.v1'
      || !hasNoStore(response.headers.get('cache-control'))
      || JSON.stringify(vary) !== JSON.stringify(['authorization', 'cookie', 'origin'])
      || response.headers.get('x-content-type-options')?.toLowerCase() !== 'nosniff'
      || response.headers.has('set-cookie')
      || bytes.byteLength < 14
      || bytes.byteLength > BOARD_LIMITS_V1.maxArtifactTotalBytes + 262_144) {
      return { kind: 'corrupt_response' };
    }
    return { kind: 'ok', value: { bytes } };
  }

  async requestArtifactNetworkFetch(input: {
    boardId: string;
    artifact: ArtifactReferenceV1;
    csrfToken: string;
    method: 'GET' | 'HEAD';
    url: string;
    signal?: AbortSignal;
  }): Promise<ApiResult<ArtifactNetworkResult>> {
    const boardId = parseBoardId(input.boardId);
    const artifact = parseArtifactReference(input.artifact);
    const requestId = createPublicId('req');
    const result = await this.coordinator.dispatchShared({
      path: `/api/v1/boards/${encodeURIComponent(boardId)}/artifacts/${encodeURIComponent(artifact.artifactId)}/versions/${encodeURIComponent(artifact.versionId)}/capability-requests/network-fetch`,
      method: 'POST',
      csrfToken: input.csrfToken,
      body: { protocolVersion: 1, type: 'artifact.network.fetch.request', requestId, method: input.method, url: input.url },
      responseKind: 'artifact-network',
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    if (result.kind !== 'ok') return result;
    const { response, bytes } = result.value;
    if (!response.ok
      || response.redirected
      || response.status !== 200
      || response.headers.get('content-type')?.toLowerCase() !== 'application/vnd.leecat.artifact-network-result.v1'
      || !hasNoStore(response.headers.get('cache-control'))
      || response.headers.get('x-content-type-options')?.toLowerCase() !== 'nosniff'
      || response.headers.has('set-cookie')) return { kind: 'corrupt_response' };
    return { kind: 'ok', value: { bytes } };
  }

  async listActivePairings(signal?: AbortSignal): Promise<ApiResult<PairingOwnerStatus[]>> {
    const result = await this.coordinator.dispatchShared({ path: '/api/v1/pairings/active', method: 'GET', ...(signal === undefined ? {} : { signal }) });
    if (result.kind !== 'ok') return result;
    if (!result.value.response.ok || !isObject(result.value.body) || !Array.isArray(result.value.body.pairings)) {
      return { kind: 'api_error', status: result.value.response.status };
    }
    return { kind: 'ok', value: result.value.body.pairings.map(parsePairingOwnerStatus) };
  }

  async listGrants(cursor: string | null = null, signal?: AbortSignal): Promise<ApiResult<{ grants: GrantSummary[]; nextCursor: string | null }>> {
    const query = cursor === null ? '' : `?cursor=${encodeURIComponent(cursor)}`;
    const result = await this.coordinator.dispatchShared({ path: `/api/v1/grants${query}`, method: 'GET', ...(signal === undefined ? {} : { signal }) });
    if (result.kind !== 'ok') return result;
    const body = result.value.body;
    if (!result.value.response.ok || !isObject(body) || !Array.isArray(body.grants) || !(body.nextCursor === null || typeof body.nextCursor === 'string')) {
      return { kind: 'api_error', status: result.value.response.status };
    }
    return { kind: 'ok', value: { grants: body.grants.map(parseGrantSummary), nextCursor: body.nextCursor } };
  }

  async createPairing(csrfToken: string): Promise<ApiResult<CreatedPairing>> {
    const result = await this.coordinator.dispatchShared({
      path: '/api/v1/pairings', method: 'POST', body: {}, csrfToken,
    });
    if (result.kind !== 'ok') return result;
    if (result.value.response.status !== 201) return { kind: 'api_error', status: result.value.response.status };
    return { kind: 'ok', value: parseCreatedPairing(result.value.body) };
  }

  async decidePairing(
    pairingId: string,
    csrfToken: string,
    decision: { decision: 'deny' } | {
      decision: 'approve';
      approvedScopes: ClientGrantCapabilityV1[];
      approvedLifecyclePermissions: LifecyclePermission[];
      destination: PairingBoardDestination;
      lifetime: 'session' | 'persistent';
    },
  ): Promise<ApiResult<PairingOwnerStatus>> {
    const result = await this.coordinator.dispatchShared({
      path: `/api/v1/pairings/${encodeURIComponent(pairingId)}/decision`,
      method: 'POST',
      body: decision,
      csrfToken,
    });
    if (result.kind !== 'ok') return result;
    if (!result.value.response.ok) return { kind: 'api_error', status: result.value.response.status };
    return { kind: 'ok', value: parsePairingOwnerStatus(result.value.body) };
  }

  async cancelPairing(pairingId: string, csrfToken: string): Promise<ApiResult<null>> {
    return this.emptyMutation(`/api/v1/pairings/${encodeURIComponent(pairingId)}`, 'DELETE', csrfToken);
  }

  async revokeGrant(grantId: string, csrfToken: string): Promise<ApiResult<null>> {
    return this.emptyMutation(`/api/v1/grants/${encodeURIComponent(grantId)}`, 'DELETE', csrfToken);
  }

  async rotateGrant(grantId: string, csrfToken: string): Promise<ApiResult<RotatedGrantCredential>> {
    const result = await this.coordinator.dispatchShared({
      path: `/api/v1/grants/${encodeURIComponent(grantId)}/rotate`,
      method: 'POST',
      body: {},
      csrfToken,
    });
    if (result.kind !== 'ok') return result;
    const body = result.value.body;
    if (
      !result.value.response.ok
      || !isObject(body)
      || body.tokenType !== 'Bearer'
      || typeof body.accessToken !== 'string'
    ) return { kind: 'api_error', status: result.value.response.status };
    return { kind: 'ok', value: { tokenType: 'Bearer', accessToken: body.accessToken, grant: parseGrantSummary(body.grant) } };
  }

  private async emptyMutation(path: string, method: 'DELETE', csrfToken: string): Promise<ApiResult<null>> {
    const result = await this.coordinator.dispatchShared({ path, method, csrfToken });
    if (result.kind !== 'ok') return result;
    return result.value.response.status === 204
      ? { kind: 'ok', value: null }
      : { kind: 'api_error', status: result.value.response.status };
  }

  private async readOperation<K extends 'board.list' | 'board.get' | 'history.list' | 'history.get' | 'artifact.get' | 'hitl.read'>(
    path: string,
    request: OperationRequest<K>,
    signal?: AbortSignal,
  ): Promise<ApiResult<K extends 'history.list' | 'history.get'
    ? { result: OperationData<K>; metadata: HistoryAdapterMetadataV1 | null }
    : OperationData<K>>> {
    const result = await this.coordinator.dispatchShared({ path, method: 'GET', ...(signal === undefined ? {} : { signal }) });
    return this.decodeOperation(result, request) as ApiResult<K extends 'history.list' | 'history.get'
      ? { result: OperationData<K>; metadata: HistoryAdapterMetadataV1 | null }
      : OperationData<K>>;
  }

  private async writeMutation(
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

  private async writeLifecycle(
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
    return decodeLifecycle(result, { requestId: request.requestId, boardId, hitlRequestId, action });
  }

  private async writeOperation<K extends 'board.create' | 'board.archive'>(
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

  private decodeOperation<K extends 'board.list' | 'board.get' | 'board.create' | 'board.archive' | 'history.list' | 'history.get' | 'artifact.get' | 'hitl.read'>(
    result: Awaited<ReturnType<SessionRequestCoordinator['dispatchShared']>>,
    request: OperationRequest<K>,
  ): ApiResult<OperationData<K> | { result: OperationData<K>; metadata: HistoryAdapterMetadataV1 | null }> {
    if (result.kind !== 'ok') return result;
    const { response, bytes } = result.value;
    const cacheControl = response.headers.get('cache-control')?.split(',').map((part) => part.trim().toLowerCase()) ?? [];
    if (response.redirected || (response.status >= 300 && response.status < 400)
      || response.headers.get('content-type')?.toLowerCase() !== 'application/json; charset=utf-8'
      || !cacheControl.includes('no-store')
      || response.headers.get('x-request-id') !== request.requestId) return { kind: 'corrupt_response' };
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
    if (request.type === 'hitl.read'
      && (value.type !== 'hitl.read' || value.hitl.hitlRequestId !== request.hitlRequestId)) {
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
    if (resultEnvelope.type !== 'mutation.result'
      || (resultEnvelope.result.type !== 'hitl.request' && resultEnvelope.result.type !== 'hitl.respond')
      || resultEnvelope.result.type !== request.command.type
      || resultEnvelope.result.hitl.hitlRequestId !== request.command.hitlRequestId) {
      return { kind: 'corrupt_response' };
    }
    const expected = request.command.type === 'hitl.request' ? request.command.request : request.command.response;
    const actual = request.command.type === 'hitl.request'
      ? resultEnvelope.result.hitl.definition
      : resultEnvelope.result.hitl.response;
    if (!sameCanonicalValue(expected, actual)) return { kind: 'corrupt_response' };
    return { kind: 'ok', value: resultEnvelope.result };
  }
}

export const createBoardRequestIdentity = (): { requestId: RequestId; idempotencyKey: IdempotencyKey } => ({
  requestId: createPublicId('req'),
  idempotencyKey: `${createPublicId('idem')}.${createPublicId('attempt')}` as IdempotencyKey,
});

const createPublicId = (prefix: string): RequestId => {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `${prefix}_${btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')}` as RequestId;
};

const operationRequest = <K extends BoardOperationRequestV1['type']>(
  value: OperationRequest<K>,
): OperationRequest<K> => {
  const parsed = BoardOperationRequestParserV1.parse(value);
  if (!parsed.ok || parsed.data.value.type !== value.type) throw new TypeError(`invalid ${value.type} request`);
  return parsed.data.value as OperationRequest<K>;
};

const parseBoardId = (value: string): BoardId => {
  const parsed = BoardIdParserV1.parse(value);
  if (!parsed.ok) throw new TypeError('invalid board ID');
  return parsed.data.value;
};

const parseRevisionId = (value: string): RevisionId => {
  const parsed = GlobalIdStringParserV1.parse(value);
  if (!parsed.ok) throw new TypeError('invalid revision ID');
  return parsed.data.value as RevisionId;
};

const parseArtifactReference = (value: ArtifactReferenceV1): ArtifactReferenceV1 => {
  const parsed = ArtifactReferenceParserV1.parse(value);
  if (!parsed.ok) throw new TypeError('invalid artifact reference');
  return parsed.data.value;
};

const parseHitlMutationRequest = <K extends 'hitl.request' | 'hitl.respond'>(
  value: MutationRequest<K>,
  kind: K,
): MutationRequest<K> => {
  const parsed = MutationRequestParserV1.parse(value);
  if (!parsed.ok || parsed.data.value.command.type !== kind) throw new TypeError(`invalid ${kind} request`);
  return parsed.data.value as MutationRequest<K>;
};

const parseHitlLifecycleRequest = <K extends 'cancel' | 'supersede'>(
  boardIdValue: string,
  hitlRequestIdValue: string,
  value: K extends 'cancel' ? HitlCancelAdapterRequest : HitlSupersedeAdapterRequest,
  action: K,
): {
  boardId: BoardId;
  hitlRequestId: HitlRequestId;
  request: K extends 'cancel' ? HitlCancelAdapterRequest : HitlSupersedeAdapterRequest;
} => {
  const allowed = action === 'cancel'
    ? ['protocolVersion', 'requestId', 'expectedRevisionId', 'expectedStateUpdatedAt']
    : ['protocolVersion', 'requestId', 'expectedRevisionId', 'expectedStateUpdatedAt', 'successorHitlRequestId'];
  if (!isObject(value) || !exactKeys(value, allowed)) throw new TypeError(`invalid hitl ${action} request`);
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
  const request = action === 'cancel'
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

const validJsonResponse = (response: Response, requestId: RequestId): boolean => {
  const cacheControl = response.headers.get('cache-control')?.split(',').map((part) => part.trim().toLowerCase()) ?? [];
  return !response.redirected
    && !(response.status >= 300 && response.status < 400)
    && response.headers.get('content-type')?.toLowerCase() === 'application/json; charset=utf-8'
    && cacheControl.includes('no-store')
    && response.headers.get('x-request-id') === requestId;
};

const sameCanonicalValue = (left: unknown, right: unknown): boolean => {
  const first = canonicalizeJsonV1(left);
  const second = canonicalizeJsonV1(right);
  if (!first.ok || !second.ok || first.data.canonicalBytes.byteLength !== second.data.canonicalBytes.byteLength) return false;
  return first.data.canonicalBytes.every((byte, index) => byte === second.data.canonicalBytes[index]);
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
  if (!validJsonResponse(response, expected.requestId) || !strict.ok || !isObject(strict.value)) return { kind: 'corrupt_response' };
  const body = strict.value;
  if (Object.keys(body).length === 1 && Object.hasOwn(body, 'error')) {
    const error = BoardErrorParserV1.parse(body.error);
    return error.ok && error.data.value.httpStatusHint === response.status
      ? { kind: 'board_error', error: error.data.value }
      : { kind: 'corrupt_response' };
  }
  if (response.status !== 200
    || !exactKeys(body, ['protocolVersion', 'type', 'requestId', 'boardId', 'action', 'replayed', 'eventIds', 'hitl'])
    || body.protocolVersion !== 1
    || body.type !== 'hitl.lifecycle.result'
    || body.requestId !== expected.requestId
    || body.boardId !== expected.boardId
    || body.action !== expected.action
    || typeof body.replayed !== 'boolean'
    || !Array.isArray(body.eventIds)) return { kind: 'corrupt_response' };
  const eventIds: string[] = [];
  for (const eventId of body.eventIds) {
    const parsed = GlobalIdStringParserV1.parse(eventId);
    if (!parsed.ok) return { kind: 'corrupt_response' };
    eventIds.push(parsed.data.value);
  }
  if (new Set(eventIds).size !== eventIds.length) return { kind: 'corrupt_response' };
  const hitl = HitlInteractionParserV1.parse(body.hitl);
  if (!hitl.ok
    || hitl.data.value.hitlRequestId !== expected.hitlRequestId
    || hitl.data.value.state !== (expected.action === 'cancel' ? 'cancelled' : 'superseded')) {
    return { kind: 'corrupt_response' };
  }
  return { kind: 'ok', value: {
    protocolVersion: 1,
    type: 'hitl.lifecycle.result',
    requestId: expected.requestId,
    boardId: expected.boardId,
    action: expected.action,
    replayed: body.replayed,
    eventIds,
    hitl: hitl.data.value,
  } };
};

const exactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => {
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

const hasNoStore = (value: string | null): boolean => value !== null && value
  .split(',')
  .map((part) => part.trim().toLowerCase())
  .includes('no-store');

const isObject = (value: unknown): value is Record<string, unknown> => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
);

const stringArray = (value: unknown): string[] => {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) throw new TypeError('invalid string array');
  return [...value];
};

const nullableString = (value: unknown): string | null => {
  if (value === null || typeof value === 'string') return value;
  throw new TypeError('invalid nullable string');
};

const parseClient = (value: unknown): PairingOwnerStatus['client'] => {
  if (value === null) return null;
  if (!isObject(value) || typeof value.clientId !== 'string' || typeof value.clientName !== 'string' || typeof value.installationFingerprint !== 'string') {
    throw new TypeError('invalid pairing client');
  }
  return { clientId: value.clientId, clientName: value.clientName, installationFingerprint: value.installationFingerprint };
};

const parsePairingOwnerStatus = (value: unknown): PairingOwnerStatus => {
  if (!isObject(value) || typeof value.pairingId !== 'string' || typeof value.state !== 'string') throw new TypeError('invalid pairing');
  const client = parseClient(value.client);
  return {
    pairingId: value.pairingId,
    state: value.state as PairingOwnerState,
    createdAt: String(value.createdAt),
    codeExpiresAt: String(value.codeExpiresAt),
    decisionExpiresAt: nullableString(value.decisionExpiresAt),
    redeemExpiresAt: nullableString(value.redeemExpiresAt),
    client,
    requestedScopes: stringArray(value.requestedScopes) as ClientGrantCapabilityV1[],
    requestedLifecyclePermissions: stringArray(value.requestedLifecyclePermissions) as LifecyclePermission[],
    approvedScopes: value.approvedScopes === null ? null : stringArray(value.approvedScopes) as ClientGrantCapabilityV1[],
    approvedLifecyclePermissions: value.approvedLifecyclePermissions === null
      ? null
      : stringArray(value.approvedLifecyclePermissions) as LifecyclePermission[],
    boardIds: value.boardIds === null ? null : stringArray(value.boardIds),
    lifetime: value.lifetime === null ? null : value.lifetime as 'session' | 'persistent',
    decidedAt: nullableString(value.decidedAt),
  };
};

const parseGrantSummary = (value: unknown): GrantSummary => {
  if (!isObject(value) || typeof value.grantId !== 'string') throw new TypeError('invalid grant');
  const client = parseClient(value.client);
  if (client === null) throw new TypeError('grant client is required');
  return {
    grantId: value.grantId,
    client,
    scopes: stringArray(value.scopes) as ClientGrantCapabilityV1[],
    lifecyclePermissions: stringArray(value.lifecyclePermissions) as LifecyclePermission[],
    boardIds: stringArray(value.boardIds),
    lifetime: value.lifetime as 'session' | 'persistent',
    status: value.status as GrantSummary['status'],
    createdAt: String(value.createdAt),
    activatedAt: nullableString(value.activatedAt),
    lastUsedAt: nullableString(value.lastUsedAt),
    expiresAt: String(value.expiresAt),
    revokedAt: nullableString(value.revokedAt),
  };
};

const parseCreatedPairing = (value: unknown): CreatedPairing => {
  if (
    !isObject(value)
    || typeof value.pairingId !== 'string'
    || typeof value.code !== 'string'
    || value.state !== 'created'
    || typeof value.codeExpiresAt !== 'string'
  ) throw new TypeError('invalid pairing creation response');
  return { pairingId: value.pairingId, code: value.code, state: 'created', codeExpiresAt: value.codeExpiresAt };
};
