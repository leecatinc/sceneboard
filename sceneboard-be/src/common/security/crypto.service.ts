import { createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';

import {
  SECURITY_HKDF_SALT,
  encodeBase64Url,
  type SecurityPurpose,
} from '../../config/security.constants.js';

export interface SecurityKeyMaterial {
  sessionToken: Uint8Array;
  grantToken: Uint8Array;
  csrf: Uint8Array;
  pairingCodePepper: Uint8Array;
  auditHmac: Uint8Array;
  rateLimitHmac: Uint8Array;
}

type RandomBytesSource = (length: number) => Buffer;

const purposeKeyOwner = (purpose: SecurityPurpose): keyof SecurityKeyMaterial => {
  if (purpose === 'session-token/v1') return 'sessionToken';
  if (purpose === 'grant-token/v1' || purpose === 'grant-list-cursor/v1') return 'grantToken';
  if (purpose.startsWith('csrf-') || purpose === 'auth-generation/v1') return 'csrf';
  if (purpose.startsWith('pairing-')) return 'pairingCodePepper';
  if (purpose.startsWith('email-verification-')) return 'auditHmac';
  if (purpose === 'board-invitation-token/v1') return 'auditHmac';
  if (purpose === 'share-password-pepper/v1') return 'pairingCodePepper';
  if (purpose.startsWith('audit-')) return 'auditHmac';
  return 'rateLimitHmac';
};

export class CryptoService {
  private readonly keys: SecurityKeyMaterial;
  private readonly randomSource: RandomBytesSource;
  private readonly derivedKeys = new Map<SecurityPurpose, Buffer>();

  constructor(keys: SecurityKeyMaterial, randomSource: RandomBytesSource = randomBytes) {
    this.keys = {
      sessionToken: Buffer.from(keys.sessionToken),
      grantToken: Buffer.from(keys.grantToken),
      csrf: Buffer.from(keys.csrf),
      pairingCodePepper: Buffer.from(keys.pairingCodePepper),
      auditHmac: Buffer.from(keys.auditHmac),
      rateLimitHmac: Buffer.from(keys.rateLimitHmac),
    };
    for (const [name, key] of Object.entries(this.keys)) {
      if (key.byteLength < 32) throw new TypeError(`${name} key must contain at least 32 bytes`);
    }
    this.randomSource = randomSource;
  }

  generatePublicIdV1(): string {
    return encodeBase64Url(this.random(16));
  }

  random(length: number): Buffer {
    if (!Number.isSafeInteger(length) || length < 1 || length > 4_096) {
      throw new TypeError('random length is outside the supported range');
    }
    const bytes = this.randomSource(length);
    if (bytes.byteLength !== length)
      throw new Error('random source returned the wrong byte length');
    return Buffer.from(bytes);
  }

  randomBase64Url(length: number): string {
    return encodeBase64Url(this.random(length));
  }

  hmac(purpose: SecurityPurpose, value: Uint8Array | string): Buffer {
    const input = typeof value === 'string' ? Buffer.from(value, 'utf8') : Buffer.from(value);
    return createHmac('sha256', this.derive(purpose)).update(input).digest();
  }

  constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
    if (left.byteLength !== right.byteLength) return false;
    return timingSafeEqual(Buffer.from(left), Buffer.from(right));
  }

  private derive(purpose: SecurityPurpose): Buffer {
    const cached = this.derivedKeys.get(purpose);
    if (cached) return cached;
    const owner = purposeKeyOwner(purpose);
    const derived = Buffer.from(
      hkdfSync(
        'sha256',
        Buffer.from(this.keys[owner]),
        SECURITY_HKDF_SALT,
        Buffer.from(purpose, 'ascii'),
        32,
      ),
    );
    this.derivedKeys.set(purpose, derived);
    return derived;
  }
}
