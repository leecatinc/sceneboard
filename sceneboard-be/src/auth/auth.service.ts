import type { AuthCredentials } from './auth.dto.js';
import { CsrfService } from './csrf.service.js';
import { SessionTokenService } from './session-token.service.js';
import { AppError } from '../common/errors/app-error.js';
import {
  parseSessionId,
  parseUserId,
  type SessionId,
  type UserId,
} from '../common/ids/public-id.js';
import { CryptoService } from '../common/security/crypto.service.js';
import {
  SESSION_ABSOLUTE_LIFETIME_MS,
  SESSION_IDLE_LIFETIME_MS,
} from '../config/security.constants.js';

export interface PasswordPort {
  validate(password: string): void;
  hash(password: string): Promise<string>;
  verify(password: string, hash: string): Promise<boolean>;
  needsRehash(hash: string): boolean;
  dummyHash(): string;
  padFailure(startedAt: number, signal?: AbortSignal): Promise<void>;
}

export interface LoginCandidate {
  id: string;
  publicId: string;
  email: string;
  passwordHash: string;
  status: 'active' | 'disabled';
  createdAt: string;
}

interface NewSessionPersistenceInput {
  sessionPublicId: SessionId;
  familyPublicId: string;
  sessionTokenLocator: Buffer;
  sessionTokenHash: Buffer;
  idleExpiresAt: number;
  absoluteExpiresAt: number;
}

export interface CreateUserWithSessionInput extends NewSessionPersistenceInput {
  userPublicId: UserId;
  email: string;
  emailNormalized: string;
  passwordHash: string;
  emailFingerprint: Buffer;
  now: number;
}

export interface CommitLoginInput extends NewSessionPersistenceInput {
  userDatabaseId: string;
  userPublicId: UserId;
  expectedPasswordHash: string;
  replacementPasswordHash: string | null;
  emailFingerprint: Buffer;
  now: number;
}

type CreateUserResult =
  | { kind: 'created'; userCreatedAt: number }
  | { kind: 'email_conflict' }
  | { kind: 'public_id_collision' };

type CommitLoginResult =
  | { kind: 'created' }
  | { kind: 'disabled' | 'stale_hash' | 'public_id_collision' };

export interface AuthPersistence {
  createUserWithSession(input: CreateUserWithSessionInput): Promise<CreateUserResult>;
  findLoginCandidate(emailNormalized: string): Promise<LoginCandidate | null>;
  commitLogin(input: CommitLoginInput): Promise<CommitLoginResult>;
}

export interface AuthSessionResponse {
  user: {
    userId: UserId;
    email: string;
    createdAt: string;
  };
  session: {
    sessionId: SessionId;
    idleExpiresAt: string;
    absoluteExpiresAt: string;
  };
  csrfToken: string;
}

export interface IssuedAuthSession {
  response: AuthSessionResponse;
  sessionCredential: string;
  sessionMaxAgeSeconds: number;
  csrfMaxAgeSeconds: number;
  authGeneration: string;
}

interface SessionDraft extends NewSessionPersistenceInput {
  credential: string;
}

const timestamp = (value: number): string => {
  if (!Number.isSafeInteger(value)) throw new TypeError('timestamp must be epoch milliseconds');
  return new Date(value).toISOString();
};

export class AuthService {
  constructor(
    private readonly persistence: AuthPersistence,
    private readonly passwords: PasswordPort,
    private readonly sessionTokens: SessionTokenService,
    private readonly csrf: CsrfService,
    private readonly crypto: CryptoService,
  ) {}

  async signup(credentials: AuthCredentials, now: number): Promise<IssuedAuthSession> {
    this.passwords.validate(credentials.password);
    const passwordHash = await this.passwords.hash(credentials.password);
    const emailFingerprint = this.crypto.hmac('audit-email/v1', credentials.emailNormalized);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const userPublicId = parseUserId(this.crypto.generatePublicIdV1());
      const session = this.createSessionDraft(now);
      const result = await this.persistence.createUserWithSession({
        userPublicId,
        email: credentials.email,
        emailNormalized: credentials.emailNormalized,
        passwordHash,
        emailFingerprint,
        now,
        ...this.persistenceSession(session),
      });
      if (result.kind === 'email_conflict') throw new AppError('AUTH_EMAIL_IN_USE');
      if (result.kind === 'public_id_collision') continue;
      return this.issueResponse({
        userPublicId,
        email: credentials.email,
        userCreatedAt: result.userCreatedAt,
        session,
        now,
      });
    }
    throw new AppError('SERVICE_UNAVAILABLE');
  }

  async login(
    credentials: AuthCredentials,
    now: number,
    signal?: AbortSignal,
  ): Promise<IssuedAuthSession> {
    const startedAt = performance.now();
    const candidate = await this.persistence.findLoginCandidate(credentials.emailNormalized);
    const passwordHash = candidate?.passwordHash ?? this.passwords.dummyHash();
    const verified = await this.passwords.verify(credentials.password, passwordHash);
    if (!candidate || !verified || candidate.status !== 'active') {
      await this.failLogin(startedAt, signal);
    }

    const activeCandidate = candidate as LoginCandidate;
    const replacementPasswordHash = this.passwords.needsRehash(activeCandidate.passwordHash)
      ? await this.passwords.hash(credentials.password)
      : null;
    const emailFingerprint = this.crypto.hmac('audit-email/v1', credentials.emailNormalized);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const session = this.createSessionDraft(now);
      const result = await this.persistence.commitLogin({
        userDatabaseId: activeCandidate.id,
        userPublicId: parseUserId(activeCandidate.publicId),
        expectedPasswordHash: activeCandidate.passwordHash,
        replacementPasswordHash,
        emailFingerprint,
        now,
        ...this.persistenceSession(session),
      });
      if (result.kind === 'public_id_collision') continue;
      if (result.kind !== 'created') await this.failLogin(startedAt, signal);
      return this.issueResponse({
        userPublicId: parseUserId(activeCandidate.publicId),
        email: activeCandidate.email,
        userCreatedAt: Date.parse(activeCandidate.createdAt),
        session,
        now,
      });
    }
    throw new AppError('SERVICE_UNAVAILABLE');
  }

  private createSessionDraft(now: number): SessionDraft {
    const issued = this.sessionTokens.issue();
    return {
      credential: issued.token,
      sessionPublicId: parseSessionId(this.crypto.generatePublicIdV1()),
      familyPublicId: this.crypto.generatePublicIdV1(),
      sessionTokenLocator: issued.locator,
      sessionTokenHash: issued.tokenHash,
      idleExpiresAt: now + SESSION_IDLE_LIFETIME_MS,
      absoluteExpiresAt: now + SESSION_ABSOLUTE_LIFETIME_MS,
    };
  }

  private persistenceSession(session: SessionDraft): NewSessionPersistenceInput {
    return {
      sessionPublicId: session.sessionPublicId,
      familyPublicId: session.familyPublicId,
      sessionTokenLocator: Buffer.from(session.sessionTokenLocator),
      sessionTokenHash: Buffer.from(session.sessionTokenHash),
      idleExpiresAt: session.idleExpiresAt,
      absoluteExpiresAt: session.absoluteExpiresAt,
    };
  }

  private issueResponse(input: {
    userPublicId: UserId;
    email: string;
    userCreatedAt: number;
    session: SessionDraft;
    now: number;
  }): IssuedAuthSession {
    const issuedCsrf = this.csrf.issueSession(
      input.session.familyPublicId,
      input.now,
      input.session.idleExpiresAt,
    );
    const response: AuthSessionResponse = {
      user: {
        userId: input.userPublicId,
        email: input.email,
        createdAt: timestamp(input.userCreatedAt),
      },
      session: {
        sessionId: input.session.sessionPublicId,
        idleExpiresAt: timestamp(input.session.idleExpiresAt),
        absoluteExpiresAt: timestamp(input.session.absoluteExpiresAt),
      },
      csrfToken: issuedCsrf.token,
    };
    return {
      response,
      sessionCredential: input.session.credential,
      sessionMaxAgeSeconds: Math.max(
        0,
        Math.floor((input.session.absoluteExpiresAt - input.now) / 1_000),
      ),
      csrfMaxAgeSeconds: Math.max(0, Math.floor((issuedCsrf.expiresAt - input.now) / 1_000)),
      authGeneration: this.csrf.authGeneration(
        's',
        input.session.sessionPublicId,
        issuedCsrf.token,
      ),
    };
  }

  private async failLogin(startedAt: number, signal?: AbortSignal): Promise<never> {
    await this.passwords.padFailure(startedAt, signal);
    throw new AppError('AUTH_INVALID_CREDENTIALS');
  }
}
