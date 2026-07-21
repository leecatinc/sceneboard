import type { BoardId, ClientGrantCapabilityV1 } from '@sceneboard/board-schema';

import type { ClientId, PairingId } from '../common/ids/public-id.js';
import { CryptoService } from '../common/security/crypto.service.js';
import { encodeBase64Url } from '../config/security.constants.js';
import {
  lifecycleValuesFromMask,
  scopeValuesFromMask,
  type LifecyclePermission,
} from '../grants/scope-map.js';

export interface PairingClientSummary {
  clientId: ClientId;
  clientName: string;
  installationFingerprint: string;
}

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
  pairingId: PairingId;
  state: PairingOwnerState;
  createdAt: string;
  codeExpiresAt: string;
  decisionExpiresAt: string | null;
  redeemExpiresAt: string | null;
  client: PairingClientSummary | null;
  requestedScopes: ClientGrantCapabilityV1[];
  requestedLifecyclePermissions: LifecyclePermission[];
  approvedScopes: ClientGrantCapabilityV1[] | null;
  approvedLifecyclePermissions: LifecyclePermission[] | null;
  boardIds: BoardId[] | null;
  lifetime: 'session' | 'persistent' | null;
  decidedAt: string | null;
}

export interface PairingOwnerStatusSource {
  pairingId: PairingId;
  state: number;
  createdAt: number;
  codeExpiresAt: number;
  decisionExpiresAt: number | null;
  redeemExpiresAt: number | null;
  client: {
    clientId: ClientId;
    clientName: string;
    installationId: string;
  } | null;
  requestedScopeMask: number;
  requestedLifecycleMask: number;
  approvedScopeMask: number | null;
  approvedLifecycleMask: number | null;
  boardIds: BoardId[] | null;
  lifetime: number | null;
  decidedAt: number | null;
}

export const buildPairingClientSummary = (
  source: { clientId: ClientId; clientName: string; installationId: string },
  crypto: CryptoService,
): PairingClientSummary => ({
  clientId: source.clientId,
  clientName: source.clientName,
  installationFingerprint: encodeBase64Url(
    crypto.hmac('audit-installation/v1', source.installationId).subarray(0, 12),
  ),
});

const stateFromNumber = (value: number): PairingOwnerState => {
  const states: Record<number, PairingOwnerState> = {
    1: 'created',
    2: 'pending',
    3: 'approved',
    4: 'redeemed',
    5: 'denied',
    6: 'cancelled',
    7: 'expired',
    8: 'locked',
  };
  const state = states[value];
  if (!state) throw new Error('database returned an invalid pairing state');
  return state;
};

const timestamp = (value: number | null): string | null =>
  value === null ? null : new Date(value).toISOString();

const lifetimeFromNumber = (value: number | null): 'session' | 'persistent' | null => {
  if (value === null) return null;
  if (value === 1) return 'session';
  if (value === 2) return 'persistent';
  throw new Error('database returned an invalid grant lifetime');
};

export const buildPairingOwnerStatus = (
  source: PairingOwnerStatusSource,
  crypto: CryptoService,
): PairingOwnerStatus => ({
  pairingId: source.pairingId,
  state: stateFromNumber(source.state),
  createdAt: new Date(source.createdAt).toISOString(),
  codeExpiresAt: new Date(source.codeExpiresAt).toISOString(),
  decisionExpiresAt: timestamp(source.decisionExpiresAt),
  redeemExpiresAt: timestamp(source.redeemExpiresAt),
  client: source.client === null ? null : buildPairingClientSummary(source.client, crypto),
  requestedScopes: scopeValuesFromMask(source.requestedScopeMask),
  requestedLifecyclePermissions: lifecycleValuesFromMask(source.requestedLifecycleMask),
  approvedScopes:
    source.approvedScopeMask === null ? null : scopeValuesFromMask(source.approvedScopeMask),
  approvedLifecyclePermissions:
    source.approvedLifecycleMask === null
      ? null
      : lifecycleValuesFromMask(source.approvedLifecycleMask),
  boardIds: source.boardIds,
  lifetime: lifetimeFromNumber(source.lifetime),
  decidedAt: timestamp(source.decidedAt),
});
