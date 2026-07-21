import { AppError } from '../common/errors/app-error.js';
import { CryptoService } from '../common/security/crypto.service.js';
import { decodeBase64UrlStrict, encodeBase64Url } from '../config/security.constants.js';

export interface IssuedSessionToken {
  token: string;
  locator: Buffer;
  tokenHash: Buffer;
}

export interface ParsedSessionToken {
  token: string;
  locator: Buffer;
}

export class SessionTokenService {
  constructor(private readonly crypto: CryptoService) {}

  issue(): IssuedSessionToken {
    const locator = this.crypto.random(16);
    const secret = this.crypto.random(32);
    const token = `lcbs_v1.${encodeBase64Url(locator)}.${encodeBase64Url(secret)}`;
    return { token, locator, tokenHash: this.crypto.hmac('session-token/v1', token) };
  }

  parse(token: string): ParsedSessionToken {
    const parts = token.split('.');
    if (
      parts.length !== 3 ||
      parts[0] !== 'lcbs_v1' ||
      parts[1] === undefined ||
      parts[2] === undefined
    ) {
      throw new AppError('UNAUTHENTICATED');
    }
    try {
      const locator = decodeBase64UrlStrict(parts[1], { exactBytes: 16 });
      decodeBase64UrlStrict(parts[2], { exactBytes: 32 });
      return { token, locator };
    } catch {
      throw new AppError('UNAUTHENTICATED');
    }
  }

  verify(token: string, expectedHash: Uint8Array): boolean {
    try {
      this.parse(token);
      return this.crypto.constantTimeEqual(
        this.crypto.hmac('session-token/v1', token),
        expectedHash,
      );
    } catch {
      return false;
    }
  }
}
