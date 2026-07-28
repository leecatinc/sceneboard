import type {
  ArtifactReferenceV1,
  BoardError,
  BoardDocumentV2,
  BoardId,
  BoardOperationRequestV1,
  BoardOperationResultDataV1,
  ClientGrantCapabilityV1,
  HitlRequestId,
  IdempotencyKey,
  MutationRequestV1,
  MutationRequestV2,
  MutationResultV1,
  MutationResultV2,
  RequestId,
  RevisionId,
  TimestampV1,
} from '@sceneboard/board-schema';
import type { HistoryHttpMetadataV1 } from '@sceneboard/board-sdk/http';
export type {
  NormalizedRetainedHistoryResultV1,
  NormalizedRetainedHistoryRowV1,
} from '@sceneboard/board-sdk/client';

import type { CoordinatorResult } from '../auth/renewal-singleflight';

export type LifecyclePermission = 'board.create' | 'board.archive';
export type PairingBoardDestination =
  | { mode: 'create'; title: string }
  | { mode: 'existing'; boardId: string }
  | { mode: 'deferred' };
export type PairingOwnerState =
  | 'created'
  | 'pending'
  | 'approved'
  | 'redeemed'
  | 'denied'
  | 'cancelled'
  | 'expired'
  | 'locked';

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

export type ApiResult<Value> =
  | CoordinatorResult<Value>
  | { kind: 'api_error'; status: number }
  | { kind: 'board_error'; error: BoardError }
  | { kind: 'corrupt_response' };

export type OperationRequest<K extends BoardOperationRequestV1['type']> =
  BoardOperationRequestV1 & { type: K };
export type OperationData<K extends BoardOperationResultDataV1['type']> =
  BoardOperationResultDataV1 & { type: K };
export type MutationRequest<K extends MutationRequestV1['command']['type']> = Omit<
  MutationRequestV1,
  'command'
> & {
  command: Extract<MutationRequestV1['command'], { type: K }>;
};
export type MutationData<K extends MutationResultV1['result']['type']> = Extract<
  MutationResultV1['result'],
  { type: K }
>;
export type DocumentMutationRequest = MutationRequestV2 & {
  command: Extract<MutationRequestV2['command'], { type: 'document.replace' }>;
};
export type DocumentMutationResult = MutationResultV2 & {
  result: Extract<MutationResultV2['result'], { type: 'document.replace' }>;
};
export type DocumentMutationBase = Omit<DocumentMutationRequest, 'command'>;
export type BrowserDocumentMutationInput = {
  request: DocumentMutationBase;
  source: BoardDocumentV2;
  operation: import('@sceneboard/board-sdk/document-transform').DocumentTransformOperationV2;
};

export type BoardListResult = OperationData<'board.list'>;
export type BoardCreateResult = OperationData<'board.create'>;
export type BoardArchiveResult = OperationData<'board.archive'>;
export type BoardGetResult = OperationData<'board.get'>;
export type BoardCapabilitiesResult = OperationData<'capabilities.get'>;
export type BoardRenameResult = { boardId: BoardId; title: string; updatedAt: TimestampV1 };
export type HistoryListResult = OperationData<'history.list'> & {
  metadata: HistoryHttpMetadataV1;
};
export type HistoryGetResult = OperationData<'history.get'> & {
  metadata: HistoryHttpMetadataV1;
};
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
export type HitlMutationRequest = HitlRequestMutationRequest | HitlRespondMutationRequest;
export type HitlMutationResult = HitlRequestResult | HitlRespondResult;
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

export type PairingDecision =
  | { decision: 'deny' }
  | {
      decision: 'approve';
      approvedScopes: ClientGrantCapabilityV1[];
      approvedLifecyclePermissions: LifecyclePermission[];
      destination: PairingBoardDestination;
      lifetime: 'session' | 'persistent';
    };

export type ArtifactNetworkFetchInput = {
  boardId: string;
  artifact: ArtifactReferenceV1;
  csrfToken: string;
  method: 'GET' | 'HEAD';
  url: string;
  signal?: AbortSignal;
};

export type CreateBoardInput = {
  title: string;
  requestId: RequestId;
  idempotencyKey: IdempotencyKey;
  csrfToken: string;
  signal?: AbortSignal;
};

export type ArchiveBoardInput = {
  boardId: string;
  requestId: RequestId;
  idempotencyKey: IdempotencyKey;
  signal?: AbortSignal;
};
