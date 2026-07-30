import { AppError } from '../common/errors/app-error.js';
import { CryptoService } from '../common/security/crypto.service.js';
import { decodeBase64UrlStrict, encodeBase64Url } from '../config/security.constants.js';

export interface IssuedAccountApiKeyToken {
  token: string;
  locator: Buffer;
  tokenHash: Buffer;
}

export class AccountApiKeyTokenCodec {
  constructor(private readonly crypto: CryptoService) {}

  issue(): IssuedAccountApiKeyToken {
    const locator = this.crypto.random(16);
    const secret = this.crypto.random(32);
    const token = `sbk_v1.${encodeBase64Url(locator)}.${encodeBase64Url(secret)}`;
    return {
      token,
      locator,
      tokenHash: this.crypto.hmac('account-api-key/v1', token),
    };
  }

  parse(token: string): { locator: Buffer; locatorText: string } {
    const match = /^sbk_v1\.([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})$/.exec(token);
    if (match?.[1] === undefined || match[2] === undefined) {
      throw new AppError('UNAUTHENTICATED');
    }
    try {
      const locator = decodeBase64UrlStrict(match[1], { exactBytes: 16 });
      decodeBase64UrlStrict(match[2], { exactBytes: 32 });
      return { locator, locatorText: match[1] };
    } catch {
      throw new AppError('UNAUTHENTICATED');
    }
  }

  hash(token: string): Buffer {
    return this.crypto.hmac('account-api-key/v1', token);
  }

  verify(token: string, expectedHash: Uint8Array): boolean {
    try {
      this.parse(token);
      return this.crypto.constantTimeEqual(this.hash(token), expectedHash);
    } catch {
      return false;
    }
  }

  prefix(locator: Uint8Array): string {
    const encoded = encodeBase64Url(locator);
    if (encoded.length !== 22) throw new AppError('SERVICE_UNAVAILABLE');
    return `sbk_v1.${encoded.slice(0, 8)}…`;
  }
}
