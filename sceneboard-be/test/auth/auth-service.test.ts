import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  AuthService,
  type AuthPersistence,
  type PasswordPort,
} from '../../src/auth/auth.service.js';
import { CsrfService } from '../../src/auth/csrf.service.js';
import { SessionTokenService } from '../../src/auth/session-token.service.js';
import { AppError } from '../../src/common/errors/app-error.js';
import { CryptoService } from '../../src/common/security/crypto.service.js';

const key = Buffer.alloc(32, 7);

const makeCrypto = (): CryptoService => {
  let byte = 0;
  return new CryptoService(
    {
      sessionToken: key,
      grantToken: key,
      csrf: key,
      pairingCodePepper: key,
      auditHmac: key,
      rateLimitHmac: key,
    },
    (length) => Buffer.alloc(length, (byte = (byte + 1) % 255)),
  );
};

class FakePasswords implements PasswordPort {
  readonly verified: Array<{ password: string; hash: string }> = [];
  readonly padded: number[] = [];
  valid = true;

  validate(password: string): void {
    if (password === 'short') throw new AppError('AUTH_PASSWORD_POLICY');
  }

  async hash(password: string): Promise<string> {
    return `hash:${password}`;
  }

  async verify(password: string, hash: string): Promise<boolean> {
    this.verified.push({ password, hash });
    return this.valid && hash === `hash:${password}`;
  }

  needsRehash(hash: string): boolean {
    return hash.startsWith('old:');
  }

  dummyHash(): string {
    return 'dummy-hash';
  }

  async padFailure(startedAt: number): Promise<void> {
    this.padded.push(startedAt);
  }
}

const credentials = {
  email: 'User@Example.dev',
  emailNormalized: 'user@example.dev',
  password: 'correct horse battery staple',
};

test('signup commits only hashes and returns the session credential out-of-band from JSON', async () => {
  const crypto = makeCrypto();
  let captured: Parameters<AuthPersistence['createUserWithSession']>[0] | undefined;
  const persistence: AuthPersistence = {
    async createUserWithSession(input) {
      captured = input;
      return { kind: 'created', userCreatedAt: input.now };
    },
    async findLoginCandidate() {
      return null;
    },
    async commitLogin() {
      throw new Error('unexpected login');
    },
  };
  const service = new AuthService(
    persistence,
    new FakePasswords(),
    new SessionTokenService(crypto),
    new CsrfService(crypto),
    crypto,
  );
  const now = 1_800_000_000_000;
  const result = await service.signup(credentials, now);

  assert.equal(captured?.emailNormalized, credentials.emailNormalized);
  assert.equal(captured?.sessionTokenHash.byteLength, 32);
  assert.equal('sessionToken' in (captured ?? {}), false);
  assert.match(result.sessionCredential, /^lcbs_v1\./);
  assert.equal('sessionCredential' in result.response, false);
  assert.deepEqual(Object.keys(result.response), ['user', 'session', 'csrfToken']);
  assert.equal(result.response.user.email, credentials.email);
  assert.match(result.authGeneration, /^[A-Za-z0-9_-]{22}$/);
});

test('signup maps only normalized-email conflicts to AUTH_EMAIL_IN_USE', async () => {
  const crypto = makeCrypto();
  const persistence: AuthPersistence = {
    async createUserWithSession() {
      return { kind: 'email_conflict' };
    },
    async findLoginCandidate() {
      return null;
    },
    async commitLogin() {
      throw new Error('unexpected login');
    },
  };
  const service = new AuthService(
    persistence,
    new FakePasswords(),
    new SessionTokenService(crypto),
    new CsrfService(crypto),
    crypto,
  );
  await assert.rejects(
    () => service.signup(credentials, 1_800_000_000_000),
    (error) => error instanceof AppError && error.code === 'AUTH_EMAIL_IN_USE',
  );
});

test('unknown and disabled login use dummy/real hashes but converge to one padded error', async () => {
  const crypto = makeCrypto();
  const passwords = new FakePasswords();
  const candidates = [
    null,
    {
      id: '9',
      publicId: 'user_disabled',
      email: credentials.email,
      passwordHash: `hash:${credentials.password}`,
      status: 'disabled' as const,
      createdAt: '2026-07-16T00:00:00.000Z',
    },
  ];
  const persistence: AuthPersistence = {
    async createUserWithSession() {
      throw new Error('unexpected signup');
    },
    async findLoginCandidate() {
      return candidates.shift() ?? null;
    },
    async commitLogin() {
      throw new Error('must not commit invalid login');
    },
  };
  const service = new AuthService(
    persistence,
    passwords,
    new SessionTokenService(crypto),
    new CsrfService(crypto),
    crypto,
  );

  for (let index = 0; index < 2; index += 1) {
    await assert.rejects(
      () => service.login(credentials, 1_800_000_000_000 + index),
      (error) => error instanceof AppError && error.code === 'AUTH_INVALID_CREDENTIALS',
    );
  }
  assert.deepEqual(
    passwords.verified.map(({ hash }) => hash),
    ['dummy-hash', `hash:${credentials.password}`],
  );
  assert.equal(passwords.padded.length, 2);
});

test('successful login rechecks state at commit and returns a fresh session generation', async () => {
  const crypto = makeCrypto();
  const passwords = new FakePasswords();
  const persistence: AuthPersistence = {
    async createUserWithSession() {
      throw new Error('unexpected signup');
    },
    async findLoginCandidate() {
      return {
        id: '11',
        publicId: 'user_active',
        email: credentials.email,
        passwordHash: `hash:${credentials.password}`,
        status: 'active',
        createdAt: '2026-07-16T00:00:00.000Z',
      };
    },
    async commitLogin(input) {
      assert.equal(input.expectedPasswordHash, `hash:${credentials.password}`);
      assert.equal(input.replacementPasswordHash, null);
      return { kind: 'created' };
    },
  };
  const service = new AuthService(
    persistence,
    passwords,
    new SessionTokenService(crypto),
    new CsrfService(crypto),
    crypto,
  );
  const result = await service.login(credentials, 1_800_000_000_000);
  assert.equal(result.response.user.userId, 'user_active');
  assert.match(result.response.csrfToken, /^lcbcsrf_v1\.s\./);
  assert.match(result.authGeneration, /^[A-Za-z0-9_-]{22}$/);
});

test('verified Google email links an active account and issues an ordinary SceneBoard session', async () => {
  const crypto = makeCrypto();
  const persistence: AuthPersistence = {
    async createUserWithSession() {
      throw new Error('existing user must not be recreated');
    },
    async findLoginCandidate() {
      return {
        id: '11',
        publicId: 'user_google',
        email: credentials.email,
        passwordHash: `hash:${credentials.password}`,
        status: 'active',
        createdAt: '2026-07-16T00:00:00.000Z',
      };
    },
    async commitLogin(input) {
      assert.equal(input.replacementPasswordHash, null);
      return { kind: 'created' };
    },
  };
  const firebaseGoogle = {
    async verify() {
      return { email: credentials.email, emailNormalized: credentials.emailNormalized };
    },
  };
  const service = new AuthService(
    persistence,
    new FakePasswords(),
    new SessionTokenService(crypto),
    new CsrfService(crypto),
    crypto,
    firebaseGoogle as never,
  );
  const result = await service.google('firebase-token', 1_800_000_000_000);
  assert.equal(result.response.user.userId, 'user_google');
  assert.match(result.response.csrfToken, /^lcbcsrf_v1\.s\./);
  assert.match(result.sessionCredential, /^lcbs_v1\./);
});

test('verified Google email creates a first-time account with an unusable random password', async () => {
  const crypto = makeCrypto();
  let captured: Parameters<AuthPersistence['createUserWithSession']>[0] | undefined;
  const persistence: AuthPersistence = {
    async createUserWithSession(input) {
      captured = input;
      return { kind: 'created', userCreatedAt: input.now };
    },
    async findLoginCandidate() {
      return null;
    },
    async commitLogin() {
      throw new Error('first-time Google identity must be created atomically');
    },
  };
  const firebaseGoogle = {
    async verify() {
      return { email: credentials.email, emailNormalized: credentials.emailNormalized };
    },
  };
  const service = new AuthService(
    persistence,
    new FakePasswords(),
    new SessionTokenService(crypto),
    new CsrfService(crypto),
    crypto,
    firebaseGoogle as never,
  );

  const result = await service.google('firebase-token', 1_800_000_000_000);

  assert.equal(captured?.emailNormalized, credentials.emailNormalized);
  assert.match(captured?.passwordHash ?? '', /^hash:[A-Za-z0-9_-]{64}$/);
  assert.doesNotMatch(captured?.passwordHash ?? '', /firebase-token/);
  assert.equal(result.response.user.email, credentials.email);
  assert.match(result.sessionCredential, /^lcbs_v1\./);
});
