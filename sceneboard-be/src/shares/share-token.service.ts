import { createHash, timingSafeEqual } from 'node:crypto';

import { ShareContractError } from '../common/errors/app-error.js';
import { CryptoService } from '../common/security/crypto.service.js';
import { decodeBase64UrlStrict, encodeBase64Url } from '../config/security.constants.js';

export type IssuedShareToken = {
  token: string;
  digest: Buffer;
};

export type PublicShareReference =
  | { kind: 'secret'; digest: Buffer }
  | { kind: 'locator'; shareId: string; accessGeneration: number; digest: Buffer };

const LOCATOR_PATTERN = /^(share_[A-Za-z0-9_-]{22})_g([1-9][0-9]{0,15})$/u;

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

  publicReference(value: string): PublicShareReference {
    const locator = LOCATOR_PATTERN.exec(value);
    if (locator !== null) {
      const accessGeneration = Number(locator[2]);
      if (!Number.isSafeInteger(accessGeneration) || accessGeneration < 1)
        throw new ShareContractError('INVALID_REQUEST');
      return {
        kind: 'locator',
        shareId: locator[1]!,
        accessGeneration,
        digest: createHash('sha256').update(value, 'ascii').digest(),
      };
    }
    return { kind: 'secret', digest: this.digest(value) };
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
