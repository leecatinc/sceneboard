import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  EmailVerificationService,
  type EmailVerificationRedisPort,
} from '../../src/auth/email-verification.service.js';
import type { VerificationEmailPort } from '../../src/auth/gmail-mailer.service.js';
import { AppError } from '../../src/common/errors/app-error.js';
import { CryptoService } from '../../src/common/security/crypto.service.js';

const key = Buffer.alloc(32, 7);
const crypto = new CryptoService({
  sessionToken: key,
  grantToken: key,
  csrf: key,
  pairingCodePepper: key,
  auditHmac: key,
  rateLimitHmac: key,
}, (length) => Buffer.alloc(length, 1));

class ScriptedRedis implements EmailVerificationRedisPort {
  readonly calls: Array<{ script: string; keys: readonly string[]; args: readonly string[] }> = [];

  constructor(private readonly results: unknown[]) {}

  async evaluate(script: string, keys: readonly string[], args: readonly string[]): Promise<unknown> {
    this.calls.push({ script, keys, args });
    if (this.results.length === 0) throw new Error('unexpected Redis call');
    const result = this.results.shift();
    if (result instanceof Error) throw result;
    return result;
  }
}

class CapturingMailer implements VerificationEmailPort {
  readonly sent: Array<{ to: string; code: string; locale: 'ko' }> = [];

  constructor(private readonly failure: Error | null = null) {}

  async sendVerificationCode(input: { to: string; code: string; locale: 'ko' }): Promise<void> {
    if (this.failure !== null) throw this.failure;
    this.sent.push(input);
  }
}

test('stores only an email fingerprint and code HMAC before sending a six-digit Gmail code', async () => {
  const redis = new ScriptedRedis([[1, 600_000]]);
  const mailer = new CapturingMailer();
  const service = new EmailVerificationService(redis, crypto, mailer, 'leecat_board:');

  const result = await service.request({
    email: 'User@Example.dev',
    emailNormalized: 'user@example.dev',
    locale: 'ko',
  });

  assert.deepEqual(result, { expiresInSeconds: 600, resendAfterSeconds: 120 });
  assert.equal(mailer.sent.length, 1);
  assert.match(mailer.sent[0]?.code ?? '', /^[0-9]{6}$/);
  assert.equal(mailer.sent[0]?.to, 'User@Example.dev');
  assert.equal(redis.calls[0]?.keys.some((value) => value.includes('user@example.dev')), false);
  assert.equal(redis.calls[0]?.args[0]?.includes(mailer.sent[0]?.code ?? ''), false);
  assert.match(redis.calls[0]?.args[0] ?? '', /^[A-Za-z0-9_-]{43}$/);
});

test('issues an email-bound short-lived ticket after one successful code claim', async () => {
  const redis = new ScriptedRedis([[1, 0]]);
  const service = new EmailVerificationService(redis, crypto, new CapturingMailer(), 'leecat_board:');
  const now = 1_800_000_000_000;

  const confirmed = await service.confirm({
    email: 'User@Example.dev',
    emailNormalized: 'user@example.dev',
    code: '123456',
  }, now);

  assert.match(confirmed.verificationTicket, /^v1\.[0-9]{13}\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/);
  assert.equal(confirmed.expiresAt, new Date(now + 15 * 60 * 1_000).toISOString());
  assert.doesNotThrow(() => service.assertTicket('user@example.dev', confirmed.verificationTicket, now));
  assert.throws(
    () => service.assertTicket('other@example.dev', confirmed.verificationTicket, now),
    (error) => error instanceof AppError && error.code === 'AUTH_EMAIL_VERIFICATION_REQUIRED',
  );
  assert.throws(
    () => service.assertTicket('user@example.dev', confirmed.verificationTicket, now + 15 * 60 * 1_000),
    (error) => error instanceof AppError && error.code === 'AUTH_EMAIL_VERIFICATION_REQUIRED',
  );
});

test('rejects an invalid or exhausted code without issuing a ticket', async () => {
  const service = new EmailVerificationService(
    new ScriptedRedis([[-1, 500_000]]),
    crypto,
    new CapturingMailer(),
    'leecat_board:',
  );
  await assert.rejects(
    () => service.confirm({
      email: 'user@example.dev',
      emailNormalized: 'user@example.dev',
      code: '000000',
    }, 1_800_000_000_000),
    (error) => error instanceof AppError && error.code === 'AUTH_EMAIL_VERIFICATION_INVALID',
  );
});

test('removes the pending code and cooldown when Gmail delivery fails', async () => {
  const redis = new ScriptedRedis([[1, 600_000], 1]);
  const service = new EmailVerificationService(
    redis,
    crypto,
    new CapturingMailer(new Error('smtp unavailable')),
    'leecat_board:',
  );
  await assert.rejects(
    () => service.request({
      email: 'user@example.dev',
      emailNormalized: 'user@example.dev',
      locale: 'ko',
    }),
    (error) => error instanceof AppError && error.code === 'SERVICE_UNAVAILABLE',
  );
  assert.equal(redis.calls.length, 2);
  assert.equal(redis.calls[1]?.args[0], redis.calls[0]?.args[0]);
});

test('returns the Redis cooldown as a retryable rate limit', async () => {
  const service = new EmailVerificationService(
    new ScriptedRedis([[0, 61_001]]),
    crypto,
    new CapturingMailer(),
    'leecat_board:',
  );
  await assert.rejects(
    () => service.request({
      email: 'user@example.dev',
      emailNormalized: 'user@example.dev',
      locale: 'ko',
    }),
    (error) => error instanceof AppError
      && error.code === 'RATE_LIMITED'
      && error.retryAfterSeconds === 62,
  );
});
