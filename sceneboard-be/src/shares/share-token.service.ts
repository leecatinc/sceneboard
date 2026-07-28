import { createHash, timingSafeEqual } from 'node:crypto';

import { ShareContractError } from '../common/errors/app-error.js';
import { CryptoService } from '../common/security/crypto.service.js';
import { decodeBase64UrlStrict, encodeBase64Url } from '../config/security.constants.js';

export type IssuedShareToken = {
  token: string;
  digest: Buffer;
};

export class ShareTokenService {
  constructor(private readonly crypto: CryptoService) {}

  issue(): IssuedShareToken {
    const token = encodeBase64Url(this.crypto.random(32));
    return { token, digest: this.digest(token) };
  }

  digest(token: string): Buffer {
    try {
      decodeBase64UrlStrict(token, { exactBytes: 32 });
    } catch {
      throw new ShareContractError('INVALID_REQUEST');
    }
    if (!/^[A-Za-z0-9_-]{43}$/u.test(token)) {
      throw new ShareContractError('INVALID_REQUEST');
    }
    return createHash('sha256').update(token, 'ascii').digest();
  }

  verify(token: string, expectedDigest: Uint8Array): boolean {
    try {
      const actual = this.digest(token);
      return expectedDigest.byteLength === 32 && timingSafeEqual(actual, expectedDigest);
    } catch {
      return false;
    }
  }
}
