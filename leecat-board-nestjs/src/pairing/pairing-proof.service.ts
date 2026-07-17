import { createHash } from 'node:crypto';

import { Injectable } from '@nestjs/common';

import { AppError } from '../common/errors/app-error.js';
import { CryptoService } from '../common/security/crypto.service.js';
import { decodeBase64UrlStrict, encodeBase64Url } from '../config/security.constants.js';

export interface PairingProofCredential {
  proof: Buffer;
  challenge: Buffer;
  rateLimitFingerprint: string;
}

@Injectable()
export class PairingProofService {
  constructor(private readonly crypto: CryptoService) {}

  parseAuthorization(value: string | string[] | undefined): PairingProofCredential {
    if (typeof value !== 'string' || !value.startsWith('PairingProof ')) {
      throw new AppError('PAIRING_PROOF_INVALID');
    }
    const encoded = value.slice('PairingProof '.length);
    if (encoded.length !== 43 || value !== `PairingProof ${encoded}`) {
      throw new AppError('PAIRING_PROOF_INVALID');
    }
    try {
      const proof = decodeBase64UrlStrict(encoded, { exactBytes: 32 });
      return {
        proof,
        challenge: createHash('sha256').update(proof).digest(),
        rateLimitFingerprint: encodeBase64Url(
          this.crypto.hmac('rate-limit-pairing/v1', proof).subarray(0, 16),
        ),
      };
    } catch {
      throw new AppError('PAIRING_PROOF_INVALID');
    }
  }
}
