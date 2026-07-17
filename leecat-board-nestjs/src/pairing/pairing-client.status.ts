import type { PairingId } from '../common/ids/public-id.js';

export type PairingClientState = 'pending' | 'approved' | 'redeemed' | 'denied' | 'cancelled' | 'expired';

export interface PairingClientStatus {
  pairingId: PairingId;
  state: PairingClientState;
  retryAfterSeconds: 2 | 5 | 10 | null;
  decisionExpiresAt: string | null;
  redeemExpiresAt: string | null;
}

export interface PairingClientStatusSource {
  pairingId: PairingId;
  state: number;
  claimedAt: number;
  decisionExpiresAt: number | null;
  redeemExpiresAt: number | null;
}

export const pendingRetryAfterSeconds = (claimedAt: number, now: number): 2 | 5 | 10 => {
  if (!Number.isSafeInteger(claimedAt) || !Number.isSafeInteger(now) || now < claimedAt) {
    throw new Error('database returned an invalid pairing clock');
  }
  const elapsed = now - claimedAt;
  if (elapsed < 30_000) return 2;
  if (elapsed < 120_000) return 5;
  return 10;
};

const stateFromNumber = (state: number): PairingClientState => {
  const states: Readonly<Record<number, PairingClientState>> = {
    2: 'pending',
    3: 'approved',
    4: 'redeemed',
    5: 'denied',
    6: 'cancelled',
    7: 'expired',
  };
  const value = states[state];
  if (value === undefined) throw new Error('database returned an unprovable pairing state');
  return value;
};

const timestamp = (value: number | null): string | null => value === null ? null : new Date(value).toISOString();

export const buildPairingClientStatus = (
  source: PairingClientStatusSource,
  now: number,
): PairingClientStatus => {
  const state = stateFromNumber(source.state);
  return {
    pairingId: source.pairingId,
    state,
    retryAfterSeconds: state === 'pending' ? pendingRetryAfterSeconds(source.claimedAt, now) : null,
    decisionExpiresAt: timestamp(source.decisionExpiresAt),
    redeemExpiresAt: timestamp(source.redeemExpiresAt),
  };
};
