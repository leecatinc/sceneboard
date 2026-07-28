import { createHash, scrypt as nodeScrypt, timingSafeEqual } from 'node:crypto';

import { CryptoService } from '../common/security/crypto.service.js';

export const SHARE_PASSWORD_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
export const SHARE_PASSWORD_LENGTH = 24;
export const SHARE_PASSWORD_HASH_VERSION = 'S1' as const;
export const SHARE_PASSWORD_PEPPER_VERSION = 1;
export const SHARE_PASSWORD_SCRYPT = {
  N: 65_536,
  r: 8,
  p: 1,
  keylen: 32,
  maxmem: 100_663_296,
} as const;
const SHARE_PASSWORD_PATTERN = /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{24}$/u;

export interface PasswordHashRecord {
  passwordHash: Buffer;
  salt: Buffer;
  hashVersion: typeof SHARE_PASSWORD_HASH_VERSION;
  pepperVersion: number;
}

const scrypt = (input: Buffer, salt: Buffer): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    nodeScrypt(
      input,
      salt,
      SHARE_PASSWORD_SCRYPT.keylen,
      {
        N: SHARE_PASSWORD_SCRYPT.N,
        r: SHARE_PASSWORD_SCRYPT.r,
        p: SHARE_PASSWORD_SCRYPT.p,
        maxmem: SHARE_PASSWORD_SCRYPT.maxmem,
      },
      (error, derived) => {
        if (error) reject(error);
        else resolve(Buffer.from(derived));
      },
    );
  });

export class PasswordHashService {
  constructor(private readonly crypto: CryptoService) {}

  generate(): string {
    const bytes = this.crypto.random(SHARE_PASSWORD_LENGTH);
    return [...bytes].map((byte) => SHARE_PASSWORD_ALPHABET[byte & 31]!).join('');
  }

  async hash(password: string, salt = this.crypto.random(16)): Promise<PasswordHashRecord> {
    const passwordBytes = Buffer.from(password, 'utf8');
    const peppered = this.crypto.hmac('share-password-pepper/v1', passwordBytes);
    return {
      passwordHash: await scrypt(peppered, salt),
      salt: Buffer.from(salt),
      hashVersion: SHARE_PASSWORD_HASH_VERSION,
      pepperVersion: SHARE_PASSWORD_PEPPER_VERSION,
    };
  }

  async verify(
    password: string,
    record: Pick<PasswordHashRecord, 'passwordHash' | 'salt' | 'hashVersion' | 'pepperVersion'>,
  ): Promise<boolean> {
    const exactPassword = SHARE_PASSWORD_PATTERN.test(password);
    if (
      record.hashVersion !== SHARE_PASSWORD_HASH_VERSION ||
      record.pepperVersion !== SHARE_PASSWORD_PEPPER_VERSION ||
      record.passwordHash.byteLength !== 32 ||
      record.salt.byteLength !== 16
    ) {
      return false;
    }
    const candidate = await this.hash(password, record.salt);
    return exactPassword && timingSafeEqual(candidate.passwordHash, record.passwordHash);
  }

  digest(record: Pick<PasswordHashRecord, 'passwordHash'>): Buffer {
    return createHash('sha256').update(record.passwordHash).digest();
  }
}

export class PasswordVerificationPool {
  private active = 0;

  constructor(private readonly maximum = 8) {
    if (!Number.isSafeInteger(maximum) || maximum < 1) {
      throw new TypeError('password verification pool maximum is invalid');
    }
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.active >= this.maximum) throw new PasswordVerificationPoolFullError();
    this.active += 1;
    try {
      return await operation();
    } finally {
      this.active -= 1;
    }
  }

  size(): number {
    return this.active;
  }
}

export class PasswordVerificationPoolFullError extends Error {
  constructor() {
    super('password verification pool is full');
    this.name = 'PasswordVerificationPoolFullError';
  }
}
