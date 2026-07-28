import { AppError } from '../common/errors/app-error.js';
import { CryptoService } from '../common/security/crypto.service.js';
import { decodeBase64UrlStrict, encodeBase64Url } from '../config/security.constants.js';

export type IssuedInvitationToken = {
  token: string;
  locator: Buffer;
  digest: Buffer;
};

export class InvitationTokenService {
  constructor(private readonly crypto: CryptoService) {}

  issue(): IssuedInvitationToken {
    const locator = this.crypto.random(16);
    const secret = this.crypto.random(32);
    const token = `lcbi_v1.${encodeBase64Url(locator)}.${encodeBase64Url(secret)}`;
    return {
      token,
      locator,
      digest: this.crypto.hmac('board-invitation-token/v1', token),
    };
  }

  parseAndDigest(token: string): { locator: Buffer; digest: Buffer } {
    const parts = token.split('.');
    if (
      parts.length !== 3 ||
      parts[0] !== 'lcbi_v1' ||
      parts[1] === undefined ||
      parts[2] === undefined
    ) {
      throw new AppError('INVALID_PAYLOAD');
    }
    try {
      decodeBase64UrlStrict(parts[2], { exactBytes: 32 });
      return {
        locator: decodeBase64UrlStrict(parts[1], { exactBytes: 16 }),
        digest: this.crypto.hmac('board-invitation-token/v1', token),
      };
    } catch {
      throw new AppError('INVALID_PAYLOAD');
    }
  }

  verify(token: string, expectedDigest: Uint8Array): boolean {
    try {
      const actual = this.parseAndDigest(token).digest;
      return this.crypto.constantTimeEqual(actual, expectedDigest);
    } catch {
      return false;
    }
  }
}
