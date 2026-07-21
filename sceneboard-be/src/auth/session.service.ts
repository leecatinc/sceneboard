import { CsrfService } from './csrf.service.js';
import { SessionTokenService } from './session-token.service.js';
import type { AuthSessionResponse, IssuedAuthSession } from './auth.service.js';
import { AppError, type D2ErrorCode } from '../common/errors/app-error.js';
import { parseSessionId, parseUserId, type SessionId } from '../common/ids/public-id.js';
import { CryptoService } from '../common/security/crypto.service.js';
import { SESSION_IDLE_LIFETIME_MS } from '../config/security.constants.js';
import type { RateLimitService } from '../rate-limit/rate-limit.service.js';

export type SessionStatus = 'active' | 'rotated' | 'revoked' | 'expired';
export type SessionTerminalReason = 'logout' | 'reuse' | 'expired' | 'disabled';

export interface SessionRecord {
  databaseId: string;
  publicId: string;
  familyPublicId: string;
  tokenHash: Buffer;
  status: SessionStatus;
  user: {
    databaseId: string;
    publicId: string;
    email: string;
    status: 'active' | 'disabled';
    createdAt: string;
  };
  idleExpiresAt: number;
  absoluteExpiresAt: number;
}

export interface SessionPersistence {
  findByLocator(locator: Buffer): Promise<SessionRecord | null>;
  terminalizeFamily(
    record: SessionRecord,
    reason: SessionTerminalReason,
    now: number,
  ): Promise<{ kind: 'committed' | 'audit_failed' }>;
  rotate(
    record: SessionRecord,
    replacement: {
      publicId: SessionId;
      familyPublicId: string;
      locator: Buffer;
      tokenHash: Buffer;
      now: number;
      idleExpiresAt: number;
      absoluteExpiresAt: number;
    },
  ): Promise<{ kind: 'created' | 'already_rotated' | 'public_id_collision' | 'audit_failed' }>;
  observeLogout(record: SessionRecord): Promise<{ kind: 'committed' | 'audit_failed' }>;
}

export class SessionResolutionError extends AppError {
  readonly clearCookies: boolean;

  constructor(
    code: Extract<
      D2ErrorCode,
      'UNAUTHENTICATED' | 'AUTH_SESSION_EXPIRED' | 'AUTH_SESSION_REVOKED' | 'AUTH_SESSION_REUSED'
    >,
    clearCookies: boolean,
  ) {
    super(code);
    this.name = 'SessionResolutionError';
    this.clearCookies = clearCookies;
  }
}

export interface ResolvedSessionResult {
  record: SessionRecord;
  response: AuthSessionResponse;
  csrfWasReissued: boolean;
  csrfMaxAgeSeconds: number;
  authGeneration: string;
}

export interface SessionControllerService {
  resolveExclusive(
    credential: string | undefined,
    csrfToken: string | undefined,
    now: number,
  ): Promise<ResolvedSessionResult>;
  renew(
    credential: string | undefined,
    currentCsrfToken: string | undefined,
    now: number,
  ): Promise<IssuedAuthSession>;
}

type CookieMode = 'exclusive' | 'shared';

export class SessionService implements SessionControllerService {
  constructor(
    private readonly persistence: SessionPersistence,
    private readonly tokens: SessionTokenService,
    private readonly csrf: CsrfService,
    private readonly crypto: CryptoService,
    private readonly renewalLimiter?: RateLimitService,
  ) {}

  async resolveExclusive(
    credential: string | undefined,
    csrfToken: string | undefined,
    now: number,
  ): Promise<ResolvedSessionResult> {
    return this.resolve(credential, csrfToken, now, 'exclusive');
  }

  async resolveShared(credential: string | undefined, now: number): Promise<SessionRecord> {
    return (await this.resolve(credential, undefined, now, 'shared')).record;
  }

  async renew(
    credential: string | undefined,
    currentCsrfToken: string | undefined,
    now: number,
  ): Promise<IssuedAuthSession> {
    const active = await this.resolveExclusive(credential, currentCsrfToken, now);
    if (currentCsrfToken === undefined || active.csrfWasReissued)
      throw new AppError('CSRF_INVALID');
    await this.renewalLimiter?.consume({
      surface: 'session-renewal-session',
      purpose: 'rate-limit-session/v1',
      identity: active.record.publicId,
      limit: 30,
      windowMs: 5 * 60 * 1_000,
    });

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const issued = this.tokens.issue();
      const sessionId = parseSessionId(this.crypto.generatePublicIdV1());
      const idleExpiresAt = Math.min(
        now + SESSION_IDLE_LIFETIME_MS,
        active.record.absoluteExpiresAt,
      );
      const rotated = await this.persistence.rotate(active.record, {
        publicId: sessionId,
        familyPublicId: active.record.familyPublicId,
        locator: issued.locator,
        tokenHash: issued.tokenHash,
        now,
        idleExpiresAt,
        absoluteExpiresAt: active.record.absoluteExpiresAt,
      });
      if (rotated.kind === 'public_id_collision') continue;
      if (rotated.kind === 'audit_failed') throw new AppError('SERVICE_UNAVAILABLE');
      if (rotated.kind === 'already_rotated') {
        await this.commitTerminal(active.record, 'reuse', now);
        throw new SessionResolutionError('AUTH_SESSION_REUSED', true);
      }
      const csrf = this.csrf.issueSession(active.record.familyPublicId, now, idleExpiresAt);
      const response: AuthSessionResponse = {
        user: active.response.user,
        session: {
          sessionId,
          idleExpiresAt: new Date(idleExpiresAt).toISOString(),
          absoluteExpiresAt: new Date(active.record.absoluteExpiresAt).toISOString(),
        },
        csrfToken: csrf.token,
      };
      return {
        response,
        sessionCredential: issued.token,
        sessionMaxAgeSeconds: Math.max(
          0,
          Math.floor((active.record.absoluteExpiresAt - now) / 1_000),
        ),
        csrfMaxAgeSeconds: Math.max(0, Math.floor((csrf.expiresAt - now) / 1_000)),
        authGeneration: this.csrf.authGeneration('s', sessionId, csrf.token),
      };
    }
    throw new AppError('SERVICE_UNAVAILABLE');
  }

  private async resolve(
    credential: string | undefined,
    currentCsrfToken: string | undefined,
    now: number,
    cookieMode: CookieMode,
  ): Promise<ResolvedSessionResult> {
    const clearCookies = cookieMode === 'exclusive';
    if (credential === undefined) throw new SessionResolutionError('UNAUTHENTICATED', clearCookies);
    let locator: Buffer;
    try {
      locator = this.tokens.parse(credential).locator;
    } catch {
      throw new SessionResolutionError('UNAUTHENTICATED', clearCookies);
    }
    const record = await this.persistence.findByLocator(locator);
    if (!record || !this.tokens.verify(credential, record.tokenHash)) {
      throw new SessionResolutionError('UNAUTHENTICATED', clearCookies);
    }

    if (record.status === 'rotated') {
      await this.commitTerminal(record, 'reuse', now);
      throw new SessionResolutionError('AUTH_SESSION_REUSED', clearCookies);
    }
    if (record.status === 'revoked')
      throw new SessionResolutionError('AUTH_SESSION_REVOKED', clearCookies);
    if (record.status === 'expired')
      throw new SessionResolutionError('AUTH_SESSION_EXPIRED', clearCookies);
    if (record.user.status === 'disabled') {
      await this.commitTerminal(record, 'disabled', now);
      throw new SessionResolutionError('AUTH_SESSION_REVOKED', clearCookies);
    }
    if (now >= record.idleExpiresAt || now >= record.absoluteExpiresAt) {
      await this.commitTerminal(record, 'expired', now);
      throw new SessionResolutionError('AUTH_SESSION_EXPIRED', clearCookies);
    }

    const csrfValid =
      currentCsrfToken !== undefined &&
      this.csrf.verify(currentCsrfToken, {
        kind: 'session',
        familyPublicId: record.familyPublicId,
        now,
      });
    const issued = csrfValid
      ? { token: currentCsrfToken, expiresAt: csrfExpiry(currentCsrfToken) }
      : this.csrf.issueSession(
          record.familyPublicId,
          now,
          Math.min(record.idleExpiresAt, record.absoluteExpiresAt),
        );
    const sessionId = parseSessionId(record.publicId);
    const response: AuthSessionResponse = {
      user: {
        userId: parseUserId(record.user.publicId),
        email: record.user.email,
        createdAt: record.user.createdAt,
      },
      session: {
        sessionId,
        idleExpiresAt: new Date(record.idleExpiresAt).toISOString(),
        absoluteExpiresAt: new Date(record.absoluteExpiresAt).toISOString(),
      },
      csrfToken: issued.token,
    };
    return {
      record,
      response,
      csrfWasReissued: !csrfValid,
      csrfMaxAgeSeconds: Math.max(0, Math.floor((issued.expiresAt - now) / 1_000)),
      authGeneration: this.csrf.authGeneration('s', sessionId, issued.token),
    };
  }

  private async commitTerminal(
    record: SessionRecord,
    reason: SessionTerminalReason,
    now: number,
  ): Promise<void> {
    const result = await this.persistence.terminalizeFamily(record, reason, now);
    if (result.kind === 'audit_failed') throw new AppError('SERVICE_UNAVAILABLE');
  }
}

const csrfExpiry = (token: string): number => {
  const value = token.split('.')[4];
  if (value === undefined || !/^[0-9]{13}$/.test(value)) throw new AppError('CSRF_INVALID');
  return Number(value);
};
