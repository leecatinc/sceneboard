import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import type { AuthenticatedRequest } from './authentication.guard.js';
import {
  PairingProofService,
  type PairingProofCredential,
} from '../../pairing/pairing-proof.service.js';

const PAIRING_PROOF_REQUIRED = Symbol('PAIRING_PROOF_REQUIRED');

export const RequirePairingProof = (): MethodDecorator => SetMetadata(PAIRING_PROOF_REQUIRED, true);

export interface PairingProofRequest extends AuthenticatedRequest {
  pairingProof?: PairingProofCredential | undefined;
}

@Injectable()
export class PairingProofGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(PairingProofService) private readonly proofs: PairingProofService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<boolean | undefined>(PAIRING_PROOF_REQUIRED, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (required !== true) return true;
    const request = context.switchToHttp().getRequest<PairingProofRequest>();
    request.pairingProof = this.proofs.parseAuthorization(request.headers.authorization);
    return true;
  }
}
