'use client';

import type {
  ArtifactReferenceV1,
  IdempotencyKey,
  PageCursorV1,
  RequestId,
} from '@sceneboard/board-schema';

import type { SessionRequestCoordinator } from '../auth/renewal-singleflight';
import { BoardArtifactApi } from './board-artifact-api';
import { createPublicId } from './board-api-core';
import { BoardConnectionApi } from './board-connection-api';
import { BoardDocumentApi } from './board-document-api';
import { BoardHitlApi } from './board-hitl-api';
import { BoardResourceApi } from './board-resource-api';
import type {
  ApiResult,
  ArchiveBoardInput,
  ArtifactGetResult,
  ArtifactNetworkFetchInput,
  ArtifactNetworkResult,
  ArtifactPackageResult,
  BoardArchiveResult,
  BoardCreateResult,
  BoardGetResult,
  BoardListResult,
  BoardRenameResult,
  BrowserDocumentMutationInput,
  CreateBoardInput,
  CreatedPairing,
  DocumentMutationRequest,
  DocumentMutationResult,
  GrantSummary,
  HistoryGetResult,
  HistoryListResult,
  HitlCancelAdapterRequest,
  HitlLifecycleResult,
  HitlReadOperationRequest,
  HitlReadResult,
  HitlRequestMutationRequest,
  HitlRequestResult,
  HitlRespondMutationRequest,
  HitlRespondResult,
  HitlSupersedeAdapterRequest,
  PairingDecision,
  PairingOwnerStatus,
  RotatedGrantCredential,
} from './board-api-types';

export type {
  ApiResult,
  ArtifactGetResult,
  ArtifactNetworkFetchInput,
  ArtifactNetworkResult,
  ArtifactPackageResult,
  BoardArchiveResult,
  BoardCreateResult,
  BoardGetResult,
  BoardListResult,
  BoardRenameResult,
  BrowserDocumentMutationInput,
  CreatedPairing,
  DocumentMutationRequest,
  DocumentMutationResult,
  GrantSummary,
  HistoryGetResult,
  HistoryListResult,
  HitlCancelAdapterRequest,
  HitlLifecycleResult,
  HitlReadOperationRequest,
  HitlReadResult,
  HitlRequestMutationRequest,
  HitlRequestResult,
  HitlRespondMutationRequest,
  HitlRespondResult,
  HitlSupersedeAdapterRequest,
  LifecyclePermission,
  PairingBoardDestination,
  PairingDecision,
  PairingOwnerState,
  PairingOwnerStatus,
  RotatedGrantCredential,
} from './board-api-types';

export { resolveSelectedDocumentPageIdV2 } from './board-document-api';

export class BoardApiClient {
  private readonly resources: BoardResourceApi;
  private readonly hitl: BoardHitlApi;
  private readonly artifacts: BoardArtifactApi;
  private readonly connections: BoardConnectionApi;
  private readonly documents: BoardDocumentApi;

  constructor(coordinator: SessionRequestCoordinator) {
    this.resources = new BoardResourceApi(coordinator);
    this.hitl = new BoardHitlApi(coordinator);
    this.artifacts = new BoardArtifactApi(coordinator);
    this.connections = new BoardConnectionApi(coordinator);
    this.documents = new BoardDocumentApi(coordinator);
  }

  private connectionApi(): BoardConnectionApi {
    return this.connections;
  }

  async listBoards(
    cursor: PageCursorV1 | null = null,
    signal?: AbortSignal,
  ): Promise<ApiResult<BoardListResult>> {
    return this.resources.listBoards(cursor, signal);
  }

  async createBoard(input: CreateBoardInput): Promise<ApiResult<BoardCreateResult>> {
    return this.resources.createBoard(input);
  }

  async getBoard(boardId: string, signal?: AbortSignal): Promise<ApiResult<BoardGetResult>> {
    return this.resources.getBoard(boardId, signal);
  }

  async archiveBoard(input: ArchiveBoardInput): Promise<ApiResult<BoardArchiveResult>> {
    return this.resources.archiveBoard(input);
  }

  async renameBoard(
    boardId: string,
    title: string,
    signal?: AbortSignal,
  ): Promise<ApiResult<BoardRenameResult>> {
    return this.resources.renameBoard(boardId, title, signal);
  }

  async listHistory(
    boardId: string,
    cursor: PageCursorV1 | null = null,
    signal?: AbortSignal,
  ): Promise<ApiResult<HistoryListResult>> {
    return this.resources.listHistory(boardId, cursor, signal);
  }

  async getHistoryRevision(
    boardId: string,
    revisionId: string,
    signal?: AbortSignal,
  ): Promise<ApiResult<HistoryGetResult>> {
    return this.resources.getHistoryRevision(boardId, revisionId, signal);
  }

  async replaceDocument(
    request: DocumentMutationRequest,
    signal?: AbortSignal,
  ): Promise<ApiResult<DocumentMutationResult>> {
    return this.documents.replace(request, signal);
  }

  async transformDocument(
    input: BrowserDocumentMutationInput,
    signal?: AbortSignal,
  ): Promise<ApiResult<DocumentMutationResult>> {
    return this.documents.transform(input, signal);
  }

  async requestInteraction(
    request: HitlRequestMutationRequest,
    signal?: AbortSignal,
  ): Promise<ApiResult<HitlRequestResult>> {
    return this.hitl.requestInteraction(request, signal);
  }

  async respondToInteraction(
    request: HitlRespondMutationRequest,
    signal?: AbortSignal,
  ): Promise<ApiResult<HitlRespondResult>> {
    return this.hitl.respondToInteraction(request, signal);
  }

  async readInteraction(
    request: HitlReadOperationRequest,
    signal?: AbortSignal,
  ): Promise<ApiResult<HitlReadResult>> {
    return this.hitl.readInteraction(request, signal);
  }

  async cancelInteraction(
    boardId: string,
    hitlRequestId: string,
    request: HitlCancelAdapterRequest,
    signal?: AbortSignal,
  ): Promise<ApiResult<HitlLifecycleResult>> {
    return this.hitl.cancelInteraction(boardId, hitlRequestId, request, signal);
  }

  async supersedeInteraction(
    boardId: string,
    hitlRequestId: string,
    request: HitlSupersedeAdapterRequest,
    signal?: AbortSignal,
  ): Promise<ApiResult<HitlLifecycleResult>> {
    return this.hitl.supersedeInteraction(boardId, hitlRequestId, request, signal);
  }

  async getArtifact(
    boardId: string,
    artifact: ArtifactReferenceV1,
    signal?: AbortSignal,
  ): Promise<ApiResult<ArtifactGetResult>> {
    return this.artifacts.getArtifact(boardId, artifact, signal);
  }

  async getArtifactPackage(
    boardId: string,
    artifact: ArtifactReferenceV1,
    signal?: AbortSignal,
  ): Promise<ApiResult<ArtifactPackageResult>> {
    return this.artifacts.getArtifactPackage(boardId, artifact, signal);
  }

  async requestArtifactNetworkFetch(
    input: ArtifactNetworkFetchInput,
  ): Promise<ApiResult<ArtifactNetworkResult>> {
    return this.artifacts.requestArtifactNetworkFetch(input);
  }

  async listActivePairings(signal?: AbortSignal): Promise<ApiResult<PairingOwnerStatus[]>> {
    return this.connectionApi().listActivePairings(signal);
  }

  async listGrants(
    cursor: string | null = null,
    signal?: AbortSignal,
  ): Promise<ApiResult<{ grants: GrantSummary[]; nextCursor: string | null }>> {
    return this.connectionApi().listGrants(cursor, signal);
  }

  async createPairing(csrfToken: string): Promise<ApiResult<CreatedPairing>> {
    return this.connectionApi().createPairing(csrfToken);
  }

  async decidePairing(
    pairingId: string,
    csrfToken: string,
    decision: PairingDecision,
  ): Promise<ApiResult<PairingOwnerStatus>> {
    return this.connectionApi().decidePairing(pairingId, csrfToken, decision);
  }

  async cancelPairing(pairingId: string, csrfToken: string): Promise<ApiResult<null>> {
    return this.connectionApi().cancelPairing(pairingId, csrfToken);
  }

  async revokeGrant(grantId: string, csrfToken: string): Promise<ApiResult<null>> {
    return this.connectionApi().revokeGrant(grantId, csrfToken);
  }

  async rotateGrant(
    grantId: string,
    csrfToken: string,
  ): Promise<ApiResult<RotatedGrantCredential>> {
    return this.connectionApi().rotateGrant(grantId, csrfToken);
  }
}

export const createBoardRequestIdentity = (): {
  requestId: RequestId;
  idempotencyKey: IdempotencyKey;
} => ({
  requestId: createPublicId('req'),
  idempotencyKey: `${createPublicId('idem')}.${createPublicId('attempt')}` as IdempotencyKey,
});
