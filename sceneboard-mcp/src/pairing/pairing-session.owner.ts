import { createHash, randomBytes } from 'node:crypto';

import type { ClientGrantCapabilityV1 } from '@sceneboard/board-schema';

import { InstallationIdentityStoreV1 } from '../credentials/installation-identity.store.js';
import { PrivateFileCredentialStoreV1 } from '../credentials/private-file-credential.store.js';
import { sameCredentialV1 } from '../credentials/credential-record.js';
import { ProfileLeaseProviderV1 } from '../credentials/profile-lease.provider.js';
import {
  ProfileLeaseErrorV1,
  type ProfileStateLeaseV1,
} from '../credentials/profile-state.lease.js';
import {
  PairingHttpClientV1,
  type PairingClaimResponseV1,
  type PairingClientStatusV1,
  type PairingLocalErrorV1,
  type PairingRedeemResponseV1,
  type PairingUpstreamErrorV1,
} from './pairing-http.client.js';

export type LifecyclePermissionV1 = 'board.create' | 'board.archive';

export type SafeRedeemedGrantV1 = {
  grantId: string;
  client: {
    clientId: string;
    clientName: string;
    installationFingerprint: string;
  };
  scopes: ClientGrantCapabilityV1[];
  lifecyclePermissions: LifecyclePermissionV1[];
  boardIds: string[];
  lifetime: 'session' | 'persistent';
  status: 'active';
  activatedAt: string;
  expiresAt: string;
};

export type BoardPairRequestResultV1 = PairingClaimResponseV1 & { hasToken: false };

export type BoardPairStatusResultV1 =
  | {
      pairingId: string;
      state: 'pending';
      retryAfterSeconds: 2 | 5 | 10;
      decisionExpiresAt: string;
      redeemExpiresAt: null;
      grant: null;
      hasToken: false;
    }
  | {
      pairingId: string;
      state: 'approved';
      retryAfterSeconds: null;
      decisionExpiresAt: string;
      redeemExpiresAt: string;
      grant: null;
      hasToken: false;
    }
  | {
      pairingId: string;
      state: 'denied';
      retryAfterSeconds: null;
      decisionExpiresAt: string;
      redeemExpiresAt: null;
      grant: null;
      hasToken: false;
    }
  | {
      pairingId: string;
      state: 'cancelled' | 'expired';
      retryAfterSeconds: null;
      decisionExpiresAt: string;
      redeemExpiresAt: string | null;
      grant: null;
      hasToken: false;
    }
  | {
      pairingId: string;
      state: 'redeemed';
      retryAfterSeconds: null;
      decisionExpiresAt: string;
      redeemExpiresAt: string;
      grant: SafeRedeemedGrantV1;
      hasToken: true;
    };

export type PairingCoordinatorLocalErrorV1 =
  | PairingLocalErrorV1
  | { code: 'PAIRING_SINK_READ_ONLY' }
  | { code: 'PAIRING_SINK_UNAVAILABLE' }
  | { code: 'PROFILE_BUSY'; reason: 'active_owner' | 'liveness_unknown' }
  | { code: 'PROFILE_LEASE_CORRUPT' }
  | { code: 'PAIRING_STATE_LOST' }
  | { code: 'PAIRING_CLAIM_OUTCOME_UNKNOWN' }
  | { code: 'PAIRING_CREDENTIAL_UNRECOVERABLE' };

export type PairingCoordinatorResultV1<T> =
  | { ok: true; value: T }
  | { ok: false; source: 'pairing'; error: PairingUpstreamErrorV1 }
  | { ok: false; source: 'local'; error: PairingCoordinatorLocalErrorV1 };

export interface PairingCoordinatorPortV1 {
  request(
    input: PairRequestInputV1,
    signal?: AbortSignal,
  ): Promise<PairingCoordinatorResultV1<BoardPairRequestResultV1>>;
  status(
    pairingId: string,
    waitTimeoutMs: number,
    signal?: AbortSignal,
  ): Promise<PairingCoordinatorResultV1<BoardPairStatusResultV1>>;
  close(): Promise<void>;
}

export type PairRequestInputV1 = {
  code: string;
  clientName: string;
  requestedScopes: ClientGrantCapabilityV1[];
  requestedLifecyclePermissions: LifecyclePermissionV1[];
};

export type PairingHttpClientFactoryV1 = (proofProvider: () => string) => PairingHttpClientV1;
export type AuthorizedConnectionProbeV1 = (
  accessToken: string,
  signal?: AbortSignal,
) => Promise<boolean>;

type LivePairingSession = {
  pairingId: string;
  decisionExpiresAt: string;
  proof: Buffer;
  lease: ProfileStateLeaseV1;
  client: PairingHttpClientV1;
  redeemAttempts: number;
};

const sleep = async (milliseconds: number, signal?: AbortSignal): Promise<boolean> => {
  if (milliseconds <= 0) return true;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve(true);
    }, milliseconds);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve(false);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
};

const safeGrant = (response: PairingRedeemResponseV1): SafeRedeemedGrantV1 => ({
  grantId: response.grant.grantId,
  client: response.grant.client,
  scopes: response.grant.scopes,
  lifecyclePermissions: response.grant.lifecyclePermissions,
  boardIds: response.grant.boardIds,
  lifetime: response.grant.lifetime,
  status: 'active',
  activatedAt: response.grant.activatedAt,
  expiresAt: response.grant.expiresAt,
});

export class PairingSessionOwnerV1 implements PairingCoordinatorPortV1 {
  private session: LivePairingSession | null = null;

  constructor(
    private readonly store: PrivateFileCredentialStoreV1,
    private readonly installations: InstallationIdentityStoreV1,
    private readonly leases: ProfileLeaseProviderV1,
    private readonly clientFactory: PairingHttpClientFactoryV1,
    private readonly connectionProbe: AuthorizedConnectionProbeV1,
  ) {}

  async request(
    input: PairRequestInputV1,
    signal?: AbortSignal,
  ): Promise<PairingCoordinatorResultV1<BoardPairRequestResultV1>> {
    if (this.session !== null) {
      return {
        ok: false,
        source: 'local',
        error: { code: 'PROFILE_BUSY', reason: 'active_owner' },
      };
    }
    if (!(await this.leases.verify()))
      return { ok: false, source: 'local', error: { code: 'PAIRING_SINK_UNAVAILABLE' } };
    try {
      await this.store.preflight();
    } catch {
      return { ok: false, source: 'local', error: { code: 'PAIRING_SINK_UNAVAILABLE' } };
    }
    let lease: ProfileStateLeaseV1;
    try {
      lease = await this.leases.acquire(this.store.stateDirectory);
    } catch (error) {
      if (error instanceof ProfileLeaseErrorV1 && error.reason === 'active_owner') {
        return {
          ok: false,
          source: 'local',
          error: { code: 'PROFILE_BUSY', reason: 'active_owner' },
        };
      }
      if (error instanceof ProfileLeaseErrorV1 && error.reason === 'lease_corrupt') {
        return { ok: false, source: 'local', error: { code: 'PROFILE_LEASE_CORRUPT' } };
      }
      return {
        ok: false,
        source: 'local',
        error: { code: 'PROFILE_BUSY', reason: 'liveness_unknown' },
      };
    }
    try {
      await this.store.read();
    } catch {
      await lease.release();
      return { ok: false, source: 'local', error: { code: 'PAIRING_SINK_UNAVAILABLE' } };
    }
    const proof = randomBytes(32);
    const client = this.clientFactory(() => proof.toString('base64url'));
    let installationId: string;
    try {
      installationId = await this.installations.getOrCreate();
    } catch {
      proof.fill(0);
      await lease.release();
      return { ok: false, source: 'local', error: { code: 'PAIRING_SINK_UNAVAILABLE' } };
    }
    const challenge = createHash('sha256').update(proof).digest('base64url');
    const claimed = await client.claim(
      {
        code: input.code,
        installationId,
        clientName: input.clientName,
        requestedScopes: input.requestedScopes,
        requestedLifecyclePermissions: input.requestedLifecyclePermissions,
        clientProofChallenge: challenge,
      },
      signal,
    );
    installationId = '';
    if (!claimed.ok) {
      proof.fill(0);
      await lease.release();
      if (claimed.source === 'local' && claimed.error.code === 'TRANSPORT_OUTCOME_UNKNOWN') {
        return { ok: false, source: 'local', error: { code: 'PAIRING_CLAIM_OUTCOME_UNKNOWN' } };
      }
      return claimed;
    }
    this.session = {
      pairingId: claimed.value.pairingId,
      decisionExpiresAt: claimed.value.decisionExpiresAt,
      proof,
      lease,
      client,
      redeemAttempts: 0,
    };
    return { ok: true, value: { ...claimed.value, hasToken: false } };
  }

  async status(
    pairingId: string,
    waitTimeoutMs: number,
    signal?: AbortSignal,
  ): Promise<PairingCoordinatorResultV1<BoardPairStatusResultV1>> {
    const session = this.session;
    if (session === null || session.pairingId !== pairingId) {
      return { ok: false, source: 'local', error: { code: 'PAIRING_STATE_LOST' } };
    }
    const deadline = performance.now() + waitTimeoutMs;
    while (true) {
      const result = await session.client.clientStatus(pairingId, signal);
      if (!result.ok) {
        if (result.source === 'pairing' && result.error.code === 'PAIRING_PROOF_INVALID')
          await this.teardown(session);
        return result;
      }
      const status = result.value;
      if (status.state === 'pending' && performance.now() < deadline) {
        const remaining = Math.max(0, deadline - performance.now());
        const delay = Math.min(status.retryAfterSeconds! * 1_000, remaining);
        if (delay > 0 && (await sleep(delay, signal))) continue;
      }
      return this.#resolveStatus(session, status, signal);
    }
  }

  async close(): Promise<void> {
    if (this.session !== null) await this.teardown(this.session);
  }

  async #resolveStatus(
    session: LivePairingSession,
    status: PairingClientStatusV1,
    signal?: AbortSignal,
  ): Promise<PairingCoordinatorResultV1<BoardPairStatusResultV1>> {
    const decisionExpiresAt = status.decisionExpiresAt!;
    if (status.state === 'pending') {
      return {
        ok: true,
        value: {
          pairingId: status.pairingId,
          state: 'pending',
          retryAfterSeconds: status.retryAfterSeconds!,
          decisionExpiresAt,
          redeemExpiresAt: null,
          grant: null,
          hasToken: false,
        },
      };
    }
    if (status.state === 'denied') {
      const value: BoardPairStatusResultV1 = {
        pairingId: status.pairingId,
        state: 'denied',
        retryAfterSeconds: null,
        decisionExpiresAt,
        redeemExpiresAt: null,
        grant: null,
        hasToken: false,
      };
      await this.teardown(session);
      return { ok: true, value };
    }
    if (status.state === 'cancelled' || status.state === 'expired') {
      const value: BoardPairStatusResultV1 = {
        pairingId: status.pairingId,
        state: status.state,
        retryAfterSeconds: null,
        decisionExpiresAt,
        redeemExpiresAt: status.redeemExpiresAt,
        grant: null,
        hasToken: false,
      };
      await this.teardown(session);
      return { ok: true, value };
    }
    if (status.state === 'redeemed') {
      await this.teardown(session);
      return { ok: false, source: 'local', error: { code: 'PAIRING_CREDENTIAL_UNRECOVERABLE' } };
    }
    if (session.redeemAttempts >= 2) {
      return { ok: false, source: 'local', error: { code: 'TRANSPORT_ERROR', phase: 'status' } };
    }
    return this.#redeem(session, decisionExpiresAt, status.redeemExpiresAt!, signal);
  }

  async #redeem(
    session: LivePairingSession,
    decisionExpiresAt: string,
    redeemExpiresAt: string,
    signal?: AbortSignal,
  ): Promise<PairingCoordinatorResultV1<BoardPairStatusResultV1>> {
    session.redeemAttempts += 1;
    const result = await session.client.redeem(session.pairingId, signal);
    if (!result.ok) {
      if (result.source === 'local' && result.error.code === 'TRANSPORT_OUTCOME_UNKNOWN') {
        const resolution = await session.client.clientStatus(session.pairingId, signal);
        if (!resolution.ok) return resolution;
        if (resolution.value.state === 'approved' && session.redeemAttempts < 2) {
          return this.#redeem(session, decisionExpiresAt, redeemExpiresAt, signal);
        }
        return this.#resolveStatus(session, resolution.value, signal);
      }
      return result;
    }
    const record = await this.store.replace(result.value.accessToken);
    const reloaded = await this.store.read();
    if (reloaded === null || !sameCredentialV1(record, reloaded)) {
      return { ok: false, source: 'local', error: { code: 'PAIRING_CREDENTIAL_UNRECOVERABLE' } };
    }
    const connected = await this.connectionProbe(record.accessToken, signal).catch(() => false);
    if (!connected) {
      return { ok: false, source: 'local', error: { code: 'TRANSPORT_ERROR', phase: 'status' } };
    }
    const grant = safeGrant(result.value);
    await this.teardown(session);
    return {
      ok: true,
      value: {
        pairingId: session.pairingId,
        state: 'redeemed',
        retryAfterSeconds: null,
        decisionExpiresAt,
        redeemExpiresAt,
        grant,
        hasToken: true,
      },
    };
  }

  private async teardown(session: LivePairingSession): Promise<void> {
    if (this.session === session) this.session = null;
    session.proof.fill(0);
    await session.lease.release();
  }
}
