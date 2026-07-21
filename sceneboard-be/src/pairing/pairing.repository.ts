import { Inject, Injectable } from '@nestjs/common';

import { AuditRepository } from '../audit/audit.repository.js';
import { BoardCreateService } from '../boards/board-create.service.js';
import { CryptoService } from '../common/security/crypto.service.js';
import { MysqlService } from '../database/mysql.service.js';
import { PairingClientPersistence } from './pairing-client.persistence.js';
import { PairingDecisionPersistence } from './pairing-decision.persistence.js';
import { PairingOwnerPersistence } from './pairing-owner.persistence.js';
import {
  type CancelPairingPersistenceResult,
  type ClaimPairingPersistenceInput,
  type ClaimPairingPersistenceResult,
  type ClientStatusPersistenceInput,
  type ClientStatusPersistenceResult,
  type CreatePairingPersistenceInput,
  type CreatePairingPersistenceResult,
  type DecidePairingPersistenceInput,
  type DecidePairingPersistenceResult,
  type OwnerPairingPersistenceInput,
  type OwnerPairingPersistenceResult,
  type RedeemPairingPersistenceInput,
  type RedeemPairingPersistenceResult,
} from './pairing-persistence.context.js';
import { PairingRequestPersistence } from './pairing-request.persistence.js';
import type { PairingOwnerStatus } from './pairing.status.js';

export type {
  CancelPairingPersistenceResult,
  ClaimPairingPersistenceInput,
  ClaimPairingPersistenceResult,
  ClientStatusPersistenceInput,
  ClientStatusPersistenceResult,
  CreatePairingPersistenceInput,
  CreatePairingPersistenceResult,
  DecidePairingPersistenceInput,
  DecidePairingPersistenceResult,
  OwnerPairingPersistenceInput,
  OwnerPairingPersistenceResult,
  RedeemPairingPersistenceInput,
  RedeemPairingPersistenceResult,
} from './pairing-persistence.context.js';

@Injectable()
export class PairingRepository {
  private readonly requests: PairingRequestPersistence;
  private readonly decisions: PairingDecisionPersistence;
  private readonly clients: PairingClientPersistence;
  private readonly owners: PairingOwnerPersistence;

  constructor(
    @Inject(MysqlService) mysql: MysqlService,
    @Inject(AuditRepository) audit: AuditRepository,
    @Inject(CryptoService) crypto: CryptoService,
    @Inject(BoardCreateService) boardCreate: BoardCreateService,
  ) {
    const dependencies = [mysql, audit, crypto, boardCreate] as const;
    this.requests = new PairingRequestPersistence(...dependencies);
    this.decisions = new PairingDecisionPersistence(...dependencies);
    this.clients = new PairingClientPersistence(...dependencies);
    this.owners = new PairingOwnerPersistence(...dependencies);
  }

  async create(input: CreatePairingPersistenceInput): Promise<CreatePairingPersistenceResult> {
    return this.requests.create(input);
  }

  async claim(input: ClaimPairingPersistenceInput): Promise<ClaimPairingPersistenceResult> {
    return this.requests.claim(input);
  }

  async decide(input: DecidePairingPersistenceInput): Promise<DecidePairingPersistenceResult> {
    return this.decisions.decide(input);
  }

  async clientStatus(input: ClientStatusPersistenceInput): Promise<ClientStatusPersistenceResult> {
    return this.clients.clientStatus(input);
  }

  async redeem(input: RedeemPairingPersistenceInput): Promise<RedeemPairingPersistenceResult> {
    return this.clients.redeem(input);
  }

  async ownerStatus(input: OwnerPairingPersistenceInput): Promise<OwnerPairingPersistenceResult> {
    return this.owners.ownerStatus(input);
  }

  async listActive(
    input: Omit<OwnerPairingPersistenceInput, 'pairingId'>,
  ): Promise<PairingOwnerStatus[]> {
    return this.owners.listActive(input);
  }

  async cancel(input: OwnerPairingPersistenceInput): Promise<CancelPairingPersistenceResult> {
    return this.owners.cancel(input);
  }
}
