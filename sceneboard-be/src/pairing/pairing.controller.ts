import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Req } from '@nestjs/common';

import { parseEmptyObject } from '../auth/auth.dto.js';
import { RequireCsrf } from '../common/guards/csrf.guard.js';
import {
  RequireSession,
  type AuthenticatedRequest,
} from '../common/guards/authentication.guard.js';
import { AppError } from '../common/errors/app-error.js';
import { PairingService, type CreatedPairingResponse } from './pairing.service.js';
import { D2RateLimited } from '../rate-limit/d2-rate-limit.guards.js';
import { parsePairingClaim } from './pairing.dto.js';
import { parsePairingDecision } from './pairing.dto.js';
import type { ClaimedPairingResponse } from './pairing.service.js';
import type { PairingOwnerStatus } from './pairing.status.js';
import {
  RequirePairingProof,
  type PairingProofRequest,
} from '../common/guards/pairing-proof.guard.js';
import type { PairingClientStatus } from './pairing-client.status.js';
import type { GrantCredentialResponse } from '../grants/grant.status.js';

@Controller('api/v1/pairings')
export class PairingController {
  constructor(@Inject(PairingService) private readonly pairings: PairingService) {}

  @Post()
  @HttpCode(201)
  @RequireSession()
  @RequireCsrf('session')
  @D2RateLimited('pairing-create')
  async create(
    @Body() input: unknown,
    @Req() request: AuthenticatedRequest,
    now: number = Date.now(),
  ): Promise<CreatedPairingResponse> {
    parseEmptyObject(input);
    if (request.authSession === undefined) throw new AppError('UNAUTHENTICATED');
    return this.pairings.create(request.authSession, now);
  }

  @Post('claim')
  @HttpCode(202)
  @D2RateLimited('pairing-claim')
  async claim(@Body() input: unknown, now: number = Date.now()): Promise<ClaimedPairingResponse> {
    return this.pairings.claim(parsePairingClaim(input), now);
  }

  @Get('active')
  @RequireSession()
  async listActive(
    @Req() request: AuthenticatedRequest,
    now: number = Date.now(),
  ): Promise<{ pairings: PairingOwnerStatus[] }> {
    if (request.authSession === undefined) throw new AppError('UNAUTHENTICATED');
    return this.pairings.listActive(request.authSession, now);
  }

  @Get(':pairingId')
  @RequireSession()
  async ownerStatus(
    @Param('pairingId') pairingId: string,
    @Req() request: AuthenticatedRequest,
    now: number = Date.now(),
  ): Promise<PairingOwnerStatus> {
    if (request.authSession === undefined) throw new AppError('UNAUTHENTICATED');
    return this.pairings.getOwnerStatus(request.authSession, pairingId, now);
  }

  @Delete(':pairingId')
  @HttpCode(204)
  @RequireSession()
  @RequireCsrf('session')
  async cancel(
    @Param('pairingId') pairingId: string,
    @Req() request: AuthenticatedRequest,
    now: number = Date.now(),
  ): Promise<void> {
    if (request.authSession === undefined) throw new AppError('UNAUTHENTICATED');
    return this.pairings.cancel(request.authSession, pairingId, now);
  }

  @Post(':pairingId/decision')
  @HttpCode(200)
  @RequireSession()
  @RequireCsrf('session')
  @D2RateLimited('pairing-decision')
  async decide(
    @Param('pairingId') pairingId: string,
    @Body() input: unknown,
    @Req() request: AuthenticatedRequest,
    now: number = Date.now(),
  ): Promise<PairingOwnerStatus> {
    if (request.authSession === undefined) throw new AppError('UNAUTHENTICATED');
    return this.pairings.decide(request.authSession, pairingId, parsePairingDecision(input), now);
  }

  @Get(':pairingId/client-status')
  @RequirePairingProof()
  @D2RateLimited('pairing-client-status')
  async clientStatus(
    @Param('pairingId') pairingId: string,
    @Req() request: PairingProofRequest,
    now: number = Date.now(),
  ): Promise<PairingClientStatus> {
    if (request.pairingProof === undefined) throw new AppError('PAIRING_PROOF_INVALID');
    return this.pairings.clientStatus(pairingId, request.pairingProof, now);
  }

  @Post(':pairingId/redeem')
  @HttpCode(200)
  @RequirePairingProof()
  @D2RateLimited('pairing-redeem')
  async redeem(
    @Param('pairingId') pairingId: string,
    @Body() input: unknown,
    @Req() request: PairingProofRequest,
    now: number = Date.now(),
  ): Promise<GrantCredentialResponse> {
    parseEmptyObject(input);
    if (request.pairingProof === undefined) throw new AppError('PAIRING_PROOF_INVALID');
    return this.pairings.redeem(pairingId, request.pairingProof, now);
  }
}
