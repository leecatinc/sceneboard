import type { PairingId } from '../common/ids/public-id.js';
import { parseClientId, parsePairingId } from '../common/ids/public-id.js';
import { AppError } from '../common/errors/app-error.js';
import { CryptoService } from '../common/security/crypto.service.js';
import { PAIRING_CODE_LIFETIME_MS, PAIRING_DECISION_LIFETIME_MS } from '../config/security.constants.js';
import type { SessionRecord } from '../auth/session.service.js';
import { PairingCodeService } from './pairing-code.service.js';
import { PairingRepository } from './pairing.repository.js';
import type { PairingClaimRequest } from './pairing.dto.js';
import type { PairingDecisionRequest } from './pairing.dto.js';
import { lifecycleMaskFromValues, scopeMaskFromValues } from '../grants/scope-map.js';
import { parseGrantId } from '../common/ids/public-id.js';
import type { PairingOwnerStatus } from './pairing.status.js';
import type { PairingProofCredential } from './pairing-proof.service.js';
import type { PairingClientStatus } from './pairing-client.status.js';
import { GrantTokenService } from '../grants/grant-token.service.js';
import type { GrantCredentialResponse } from '../grants/grant.status.js';

export interface CreatedPairingResponse {
  pairingId: PairingId;
  code: string;
  state: 'created';
  codeExpiresAt: string;
}

export interface ClaimedPairingResponse {
  pairingId: PairingId;
  state: 'pending';
  decisionExpiresAt: string;
  pollAfterSeconds: 2;
}

type Delay = (milliseconds: number) => Promise<void>;

export class PairingService {
  constructor(
    private readonly repository: PairingRepository,
    private readonly codes: PairingCodeService,
    private readonly crypto: CryptoService,
    private readonly failureMinimumMs = 50,
    private readonly failureJitterMs = 10,
    private readonly delay: Delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    private readonly grantTokens: GrantTokenService = new GrantTokenService(crypto),
  ) {}

  async create(session: SessionRecord, now: number): Promise<CreatedPairingResponse> {
    const codeExpiresAt = now + PAIRING_CODE_LIFETIME_MS;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const code = this.codes.issue();
      const pairingId = parsePairingId(this.crypto.generatePublicIdV1());
      const result = await this.repository.create({
        publicId: pairingId,
        ownerUserDatabaseId: session.user.databaseId,
        sourceSessionDatabaseId: session.databaseId,
        ownerUserPublicId: session.user.publicId,
        sourceSessionPublicId: session.publicId,
        locatorHash: code.locatorHash,
        verifierHash: code.verifierHash,
        now,
        codeExpiresAt,
      });
      if (result.kind === 'collision') continue;
      if (result.kind === 'quota') throw new AppError('RATE_LIMITED', { retryAfterSeconds: result.retryAfterSeconds });
      if (result.kind === 'unavailable') throw new AppError('SERVICE_UNAVAILABLE');
      return {
        pairingId,
        code: code.code,
        state: 'created',
        codeExpiresAt: new Date(codeExpiresAt).toISOString(),
      };
    }
    throw new AppError('SERVICE_UNAVAILABLE');
  }

  async claim(request: PairingClaimRequest, now: number): Promise<ClaimedPairingResponse> {
    const startedAt = performance.now();
    let hashed: ReturnType<PairingCodeService['hash']>;
    try {
      hashed = this.codes.hash(this.codes.parse(request.code));
    } catch {
      await this.padFailure(startedAt);
      throw new AppError('PAIRING_UNAVAILABLE');
    }
    const decisionExpiresAt = now + PAIRING_DECISION_LIFETIME_MS;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const result = await this.repository.claim({
        clientPublicId: parseClientId(this.crypto.generatePublicIdV1()),
        locatorHash: hashed.locatorHash,
        verifierHash: hashed.verifierHash,
        installationId: request.installationId,
        clientName: request.clientName,
        clientProofChallenge: request.clientProofChallenge,
        requestedScopeMask: scopeMaskFromValues(request.requestedScopes),
        requestedLifecycleMask: lifecycleMaskFromValues(request.requestedLifecyclePermissions),
        now,
        decisionExpiresAt,
      });
      if (result.kind === 'collision') continue;
      if (result.kind === 'service_unavailable') throw new AppError('SERVICE_UNAVAILABLE');
      if (result.kind === 'unavailable') {
        await this.padFailure(startedAt);
        throw new AppError('PAIRING_UNAVAILABLE');
      }
      return {
        pairingId: result.pairingId,
        state: 'pending',
        decisionExpiresAt: new Date(decisionExpiresAt).toISOString(),
        pollAfterSeconds: 2,
      };
    }
    throw new AppError('SERVICE_UNAVAILABLE');
  }

  async decide(
    session: SessionRecord,
    pairingIdInput: string,
    request: PairingDecisionRequest,
    now: number,
  ): Promise<PairingOwnerStatus> {
    const pairingId = parsePairingId(pairingIdInput);
    const attempts = request.decision === 'approve' ? 5 : 1;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const common = {
        pairingId,
        ownerUserDatabaseId: session.user.databaseId,
        ownerUserPublicId: session.user.publicId,
        approvingSessionDatabaseId: session.databaseId,
        approvingSessionPublicId: session.publicId,
        approvingFamilyPublicId: session.familyPublicId,
        now,
      };
      const result = request.decision === 'deny'
        ? await this.repository.decide({ ...common, decision: 'deny' })
        : await this.repository.decide({
          ...common,
          decision: 'approve',
          grantPublicId: parseGrantId(this.crypto.generatePublicIdV1()),
          approvedScopeMask: scopeMaskFromValues(request.approvedScopes),
          approvedLifecycleMask: lifecycleMaskFromValues(request.approvedLifecyclePermissions),
          boardIds: request.boardIds,
          lifetime: request.lifetime,
        });
      if (result.kind === 'decided') return result.status;
      if (result.kind === 'collision') continue;
      if (result.kind === 'not_found') throw new AppError('PAIRING_NOT_FOUND');
      if (result.kind === 'conflict') throw new AppError('PAIRING_STATE_CONFLICT');
      if (result.kind === 'scope_invalid') throw new AppError('PAIRING_SCOPE_INVALID');
      throw new AppError('SERVICE_UNAVAILABLE');
    }
    throw new AppError('SERVICE_UNAVAILABLE');
  }

  async clientStatus(
    pairingIdInput: string,
    proof: PairingProofCredential,
    now: number,
  ): Promise<PairingClientStatus> {
    const result = await this.repository.clientStatus({
      pairingId: parsePairingId(pairingIdInput),
      proofChallenge: proof.challenge,
      now,
    });
    if (result.kind === 'status') return result.status;
    if (result.kind === 'proof_invalid') throw new AppError('PAIRING_PROOF_INVALID');
    throw new AppError('SERVICE_UNAVAILABLE');
  }

  async getOwnerStatus(
    session: SessionRecord,
    pairingIdInput: string,
    now: number,
  ): Promise<PairingOwnerStatus> {
    const result = await this.repository.ownerStatus({
      pairingId: parsePairingId(pairingIdInput),
      ownerUserDatabaseId: session.user.databaseId,
      ownerUserPublicId: session.user.publicId,
      sessionPublicId: session.publicId,
      now,
    });
    if (result.kind === 'status') return result.status;
    if (result.kind === 'not_found') throw new AppError('PAIRING_NOT_FOUND');
    throw new AppError('SERVICE_UNAVAILABLE');
  }

  async listActive(session: SessionRecord, now: number): Promise<{ pairings: PairingOwnerStatus[] }> {
    try {
      const pairings = await this.repository.listActive({
        ownerUserDatabaseId: session.user.databaseId,
        ownerUserPublicId: session.user.publicId,
        sessionPublicId: session.publicId,
        now,
      });
      return { pairings };
    } catch {
      throw new AppError('SERVICE_UNAVAILABLE');
    }
  }

  async cancel(session: SessionRecord, pairingIdInput: string, now: number): Promise<void> {
    const result = await this.repository.cancel({
      pairingId: parsePairingId(pairingIdInput),
      ownerUserDatabaseId: session.user.databaseId,
      ownerUserPublicId: session.user.publicId,
      sessionPublicId: session.publicId,
      now,
    });
    if (result.kind === 'cancelled') return;
    if (result.kind === 'not_found') throw new AppError('PAIRING_NOT_FOUND');
    if (result.kind === 'conflict') throw new AppError('PAIRING_STATE_CONFLICT');
    throw new AppError('SERVICE_UNAVAILABLE');
  }

  async redeem(
    pairingIdInput: string,
    proof: PairingProofCredential,
    now: number,
  ): Promise<GrantCredentialResponse> {
    const issued = this.grantTokens.issue();
    const result = await this.repository.redeem({
      pairingId: parsePairingId(pairingIdInput),
      proofChallenge: proof.challenge,
      credentialLocator: issued.locator,
      credentialHash: issued.tokenHash,
      now,
    });
    if (result.kind === 'redeemed') {
      return { tokenType: 'Bearer', accessToken: issued.token, grant: result.grant };
    }
    if (result.kind === 'proof_invalid') throw new AppError('PAIRING_PROOF_INVALID');
    if (result.kind === 'not_ready') {
      throw new AppError('PAIRING_NOT_READY', { retryAfterSeconds: result.retryAfterSeconds });
    }
    if (result.kind === 'terminal') throw new AppError('PAIRING_TERMINAL');
    throw new AppError('SERVICE_UNAVAILABLE');
  }

  private async padFailure(startedAt: number): Promise<void> {
    const jitter = this.crypto.random(2).readUInt16BE(0) % (this.failureJitterMs + 1);
    const remaining = Math.ceil(this.failureMinimumMs + jitter - (performance.now() - startedAt));
    if (remaining > 0) await this.delay(remaining);
  }
}
