import { AppError } from '../common/errors/app-error.js';
import { CryptoService } from '../common/security/crypto.service.js';
import { decodeBase64UrlStrict, encodeBase64Url } from '../config/security.constants.js';
import type {
  EmailVerificationConfirmation,
  EmailVerificationRequest,
} from './auth.dto.js';
import type { VerificationEmailPort } from './gmail-mailer.service.js';

export interface EmailVerificationRedisPort {
  evaluate(script: string, keys: readonly string[], args: readonly string[]): Promise<unknown>;
}

export interface EmailVerificationRequested {
  expiresInSeconds: number;
  resendAfterSeconds: number;
}

export interface EmailVerificationConfirmed {
  verificationTicket: string;
  expiresAt: string;
}

const CODE_LIFETIME_MS = 10 * 60 * 1_000;
const RESEND_COOLDOWN_MS = 2 * 60 * 1_000;
const TICKET_LIFETIME_MS = 15 * 60 * 1_000;
const MAX_CODE_ATTEMPTS = 5;
const TICKET_PATTERN = /^v1\.([0-9]{13})\.([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})$/;

const BEGIN_VERIFICATION_LUA = `
if redis.call('EXISTS', KEYS[2]) == 1 then
  return {0, redis.call('PTTL', KEYS[2])}
end
redis.call('HSET', KEYS[1], 'hash', ARGV[1], 'attempts', '0')
redis.call('PEXPIRE', KEYS[1], ARGV[2])
redis.call('SET', KEYS[2], '1', 'PX', ARGV[3])
return {1, tonumber(ARGV[2])}
`;

const CANCEL_VERIFICATION_LUA = `
if redis.call('HGET', KEYS[1], 'hash') == ARGV[1] then
  redis.call('DEL', KEYS[1])
  redis.call('DEL', KEYS[2])
end
return 1
`;

const CONFIRM_VERIFICATION_LUA = `
local current = redis.call('HGET', KEYS[1], 'hash')
if not current then
  return {0, 0}
end
if current == ARGV[1] then
  redis.call('DEL', KEYS[1])
  return {1, 0}
end
local attempts = redis.call('HINCRBY', KEYS[1], 'attempts', 1)
local ttl = redis.call('PTTL', KEYS[1])
if attempts >= tonumber(ARGV[2]) then
  redis.call('DEL', KEYS[1])
  return {-2, 0}
end
return {-1, ttl}
`;

export class EmailVerificationService {
  constructor(
    private readonly redis: EmailVerificationRedisPort,
    private readonly crypto: CryptoService,
    private readonly mailer: VerificationEmailPort,
    private readonly keyPrefix: string,
  ) {
    if (keyPrefix !== 'leecat_board:') throw new TypeError('Redis key prefix must be leecat_board:');
  }

  async request(input: EmailVerificationRequest): Promise<EmailVerificationRequested> {
    const code = this.generateCode();
    const codeHash = this.codeHash(input.emailNormalized, code);
    const keys = this.keys(input.emailNormalized);
    let admitted: readonly [number, number];
    try {
      admitted = parseIntegerPair(await this.redis.evaluate(
        BEGIN_VERIFICATION_LUA,
        [keys.verification, keys.cooldown],
        [codeHash, String(CODE_LIFETIME_MS), String(RESEND_COOLDOWN_MS)],
      ));
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError('SERVICE_UNAVAILABLE', { cause: error, retryAfterSeconds: 5 });
    }
    if (admitted[0] !== 1) {
      throw new AppError('RATE_LIMITED', {
        retryAfterSeconds: Math.max(1, Math.ceil(admitted[1] / 1_000)),
      });
    }

    try {
      await this.mailer.sendVerificationCode({ to: input.email, code, locale: input.locale });
    } catch (error) {
      await this.cancelFailedDelivery(keys, codeHash);
      throw new AppError('SERVICE_UNAVAILABLE', { cause: error, retryAfterSeconds: 30 });
    }
    return {
      expiresInSeconds: CODE_LIFETIME_MS / 1_000,
      resendAfterSeconds: RESEND_COOLDOWN_MS / 1_000,
    };
  }

  async confirm(input: EmailVerificationConfirmation, now: number): Promise<EmailVerificationConfirmed> {
    if (!Number.isSafeInteger(now)) throw new TypeError('timestamp must be epoch milliseconds');
    const keys = this.keys(input.emailNormalized);
    let result: readonly [number, number];
    try {
      result = parseIntegerPair(await this.redis.evaluate(
        CONFIRM_VERIFICATION_LUA,
        [keys.verification],
        [this.codeHash(input.emailNormalized, input.code), String(MAX_CODE_ATTEMPTS)],
      ));
    } catch (error) {
      throw new AppError('SERVICE_UNAVAILABLE', { cause: error, retryAfterSeconds: 5 });
    }
    if (result[0] !== 1) throw new AppError('AUTH_EMAIL_VERIFICATION_INVALID');
    const expiresAt = now + TICKET_LIFETIME_MS;
    return {
      verificationTicket: this.issueTicket(input.emailNormalized, expiresAt),
      expiresAt: new Date(expiresAt).toISOString(),
    };
  }

  assertTicket(emailNormalized: string, ticket: string, now: number): void {
    if (!Number.isSafeInteger(now)) throw new TypeError('timestamp must be epoch milliseconds');
    const match = TICKET_PATTERN.exec(ticket);
    if (match === null) throw new AppError('AUTH_EMAIL_VERIFICATION_REQUIRED');
    const expiresAt = Number(match[1]);
    const nonce = match[2] as string;
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= now || expiresAt > now + TICKET_LIFETIME_MS) {
      throw new AppError('AUTH_EMAIL_VERIFICATION_REQUIRED');
    }
    const expected = this.ticketSignature(emailNormalized, expiresAt, nonce);
    let provided: Buffer;
    try {
      provided = decodeBase64UrlStrict(match[3] as string, { exactBytes: 32 });
    } catch {
      throw new AppError('AUTH_EMAIL_VERIFICATION_REQUIRED');
    }
    if (!this.crypto.constantTimeEqual(provided, expected)) throw new AppError('AUTH_EMAIL_VERIFICATION_REQUIRED');
  }

  private generateCode(): string {
    const range = 900_000;
    const ceiling = Math.floor(0x1_0000_0000 / range) * range;
    for (;;) {
      const candidate = this.crypto.random(4).readUInt32BE(0);
      if (candidate < ceiling) return String(100_000 + candidate % range);
    }
  }

  private codeHash(emailNormalized: string, code: string): string {
    return encodeBase64Url(this.crypto.hmac('email-verification-code/v1', `${emailNormalized}\u0000${code}`));
  }

  private issueTicket(emailNormalized: string, expiresAt: number): string {
    const nonce = this.crypto.randomBase64Url(16);
    const signature = encodeBase64Url(this.ticketSignature(emailNormalized, expiresAt, nonce));
    return `v1.${expiresAt}.${nonce}.${signature}`;
  }

  private ticketSignature(emailNormalized: string, expiresAt: number, nonce: string): Buffer {
    return this.crypto.hmac('email-verification-ticket/v1', `${emailNormalized}\u0000${expiresAt}\u0000${nonce}`);
  }

  private keys(emailNormalized: string): { verification: string; cooldown: string } {
    const fingerprint = encodeBase64Url(this.crypto.hmac('audit-email/v1', emailNormalized));
    return {
      verification: `${this.keyPrefix}auth:email-verification:v1:${fingerprint}`,
      cooldown: `${this.keyPrefix}auth:email-verification-cooldown:v1:${fingerprint}`,
    };
  }

  private async cancelFailedDelivery(
    keys: { verification: string; cooldown: string },
    codeHash: string,
  ): Promise<void> {
    try {
      await this.redis.evaluate(CANCEL_VERIFICATION_LUA, [keys.verification, keys.cooldown], [codeHash]);
    } catch {
      // 원래 Gmail 발송 실패를 유지하고 정리 실패 정보는 외부에 노출하지 않는다.
    }
  }
}

const parseIntegerPair = (value: unknown): readonly [number, number] => {
  if (!Array.isArray(value) || value.length !== 2) throw new TypeError('Redis verification result is invalid');
  const first = Number(value[0]);
  const second = Number(value[1]);
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(second)) {
    throw new TypeError('Redis verification result contains invalid numbers');
  }
  return [first, second];
};
