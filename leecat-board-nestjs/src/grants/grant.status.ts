import type { BoardId } from '@leecat-board/board-schema';

import type { GrantId } from '../common/ids/public-id.js';
import type { PairingClientSummary } from '../pairing/pairing.status.js';
import {
  lifecycleValuesFromMask,
  scopeValuesFromMask,
  type LifecyclePermission,
} from './scope-map.js';
import type { ClientGrantCapabilityV1 } from '@leecat-board/board-schema';

export type GrantState = 'pending_redemption' | 'active' | 'revoked' | 'expired';

export interface GrantSummary {
  grantId: GrantId;
  client: PairingClientSummary;
  scopes: ClientGrantCapabilityV1[];
  lifecyclePermissions: LifecyclePermission[];
  boardIds: BoardId[];
  lifetime: 'session' | 'persistent';
  status: GrantState;
  createdAt: string;
  activatedAt: string | null;
  lastUsedAt: string | null;
  expiresAt: string;
  revokedAt: string | null;
}

export interface GrantCredentialResponse {
  tokenType: 'Bearer';
  accessToken: string;
  grant: GrantSummary;
}

export interface GrantSummarySource {
  grantId: GrantId;
  client: PairingClientSummary;
  scopeMask: number;
  lifecycleMask: number;
  boardIds: BoardId[];
  lifetime: number;
  status: number;
  createdAt: number;
  activatedAt: number | null;
  lastUsedAt: number | null;
  expiresAt: number;
  revokedAt: number | null;
}

const timestamp = (value: number | null): string | null => value === null ? null : new Date(value).toISOString();

const lifetimeFromNumber = (value: number): 'session' | 'persistent' => {
  if (value === 1) return 'session';
  if (value === 2) return 'persistent';
  throw new Error('database returned an invalid grant lifetime');
};

const stateFromNumber = (value: number): GrantState => {
  const states: Readonly<Record<number, GrantState>> = {
    1: 'pending_redemption',
    2: 'active',
    3: 'revoked',
    4: 'expired',
  };
  const state = states[value];
  if (state === undefined) throw new Error('database returned an invalid grant state');
  return state;
};

export const buildGrantSummary = (source: GrantSummarySource): GrantSummary => ({
  grantId: source.grantId,
  client: source.client,
  scopes: scopeValuesFromMask(source.scopeMask),
  lifecyclePermissions: lifecycleValuesFromMask(source.lifecycleMask),
  boardIds: source.boardIds,
  lifetime: lifetimeFromNumber(source.lifetime),
  status: stateFromNumber(source.status),
  createdAt: new Date(source.createdAt).toISOString(),
  activatedAt: timestamp(source.activatedAt),
  lastUsedAt: timestamp(source.lastUsedAt),
  expiresAt: new Date(source.expiresAt).toISOString(),
  revokedAt: timestamp(source.revokedAt),
});
