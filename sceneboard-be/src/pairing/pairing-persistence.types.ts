import type { BoardId, ShortText } from '@sceneboard/board-schema';

import type { ClientId, GrantId, PairingId } from '../common/ids/public-id.js';
import type { GrantSummary } from '../grants/grant.status.js';
import type { PairingClientStatus } from './pairing-client.status.js';
import type { PairingOwnerStatus } from './pairing.status.js';

export interface CreatePairingPersistenceInput {
  publicId: PairingId;
  ownerUserDatabaseId: string;
  sourceSessionDatabaseId: string;
  ownerUserPublicId: string;
  sourceSessionPublicId: string;
  locatorHash: Buffer;
  verifierHash: Buffer;
  now: number;
  codeExpiresAt: number;
}

export type CreatePairingPersistenceResult =
  | { kind: 'created' }
  | { kind: 'quota'; retryAfterSeconds: number }
  | { kind: 'collision' }
  | { kind: 'unavailable' };

export interface ClaimPairingPersistenceInput {
  clientPublicId: ClientId;
  locatorHash: Buffer;
  verifierHash: Buffer;
  installationId: string;
  clientName: string;
  clientProofChallenge: Buffer;
  requestedScopeMask: number;
  requestedLifecycleMask: number;
  now: number;
  decisionExpiresAt: number;
}

export type ClaimPairingPersistenceResult =
  | { kind: 'claimed'; pairingId: PairingId }
  | { kind: 'unavailable' }
  | { kind: 'collision' }
  | { kind: 'service_unavailable' };

export type DecidePairingPersistenceInput = {
  pairingId: PairingId;
  ownerUserDatabaseId: string;
  ownerUserPublicId: string;
  approvingSessionDatabaseId: string;
  approvingSessionPublicId: string;
  approvingFamilyPublicId: string;
  now: number;
} & (
  | { decision: 'deny' }
  | {
      decision: 'approve';
      grantPublicId: GrantId;
      approvedScopeMask: number;
      approvedLifecycleMask: number;
      destination:
        | { mode: 'create'; title: ShortText }
        | { mode: 'existing'; boardId: BoardId }
        | { mode: 'deferred' };
      lifetime: 'session' | 'persistent';
    }
);

export type DecidePairingPersistenceResult =
  | { kind: 'decided'; status: PairingOwnerStatus }
  | { kind: 'not_found' | 'conflict' | 'scope_invalid' | 'collision' | 'service_unavailable' };

export interface ClientStatusPersistenceInput {
  pairingId: PairingId;
  proofChallenge: Buffer;
  now: number;
}

export type ClientStatusPersistenceResult =
  | { kind: 'status'; status: PairingClientStatus }
  | { kind: 'proof_invalid' | 'service_unavailable' };

export interface RedeemPairingPersistenceInput {
  pairingId: PairingId;
  proofChallenge: Buffer;
  credentialLocator: Buffer;
  credentialHash: Buffer;
  now: number;
}

export type RedeemPairingPersistenceResult =
  | { kind: 'redeemed'; grant: GrantSummary }
  | { kind: 'not_ready'; retryAfterSeconds: 2 | 5 | 10 }
  | { kind: 'proof_invalid' | 'terminal' | 'collision' | 'service_unavailable' };

export interface OwnerPairingPersistenceInput {
  pairingId: PairingId;
  ownerUserDatabaseId: string;
  ownerUserPublicId: string;
  sessionPublicId: string;
  now: number;
}

export type OwnerPairingPersistenceResult =
  | { kind: 'status'; status: PairingOwnerStatus }
  | { kind: 'not_found' | 'service_unavailable' };

export type CancelPairingPersistenceResult =
  | { kind: 'cancelled' }
  | { kind: 'not_found' | 'conflict' | 'service_unavailable' };
