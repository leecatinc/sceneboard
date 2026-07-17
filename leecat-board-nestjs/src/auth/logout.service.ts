import { AppError } from '../common/errors/app-error.js';
import { CsrfService } from './csrf.service.js';
import {
  SessionResolutionError,
  type SessionPersistence,
  type SessionRecord,
} from './session.service.js';
import { SessionTokenService } from './session-token.service.js';

export class LogoutClearableError extends AppError {
  readonly clearCookies = true;
}

export interface LogoutControllerService {
  logout(
    credential: string | undefined,
    csrfCookie: string | undefined,
    csrfHeader: string | undefined,
    now: number,
  ): Promise<void>;
}

export class LogoutService implements LogoutControllerService {
  constructor(
    private readonly persistence: SessionPersistence,
    private readonly tokens: SessionTokenService,
    private readonly csrf: CsrfService,
  ) {}

  async logout(
    credential: string | undefined,
    csrfCookie: string | undefined,
    csrfHeader: string | undefined,
    now: number,
  ): Promise<void> {
    if (credential === undefined && csrfCookie === undefined && csrfHeader === undefined) return;
    this.assertSignatureOnlyCsrf(csrfCookie, csrfHeader, now);
    if (credential === undefined) return;

    let locator: Buffer;
    try {
      locator = this.tokens.parse(credential).locator;
    } catch {
      return;
    }
    const record = await this.persistence.findByLocator(locator);
    if (record === null || !this.tokens.verify(credential, record.tokenHash)) return;
    if (csrfCookie === undefined || !this.csrf.verify(csrfCookie, {
      kind: 'session',
      familyPublicId: record.familyPublicId,
      now,
    })) throw new AppError('CSRF_INVALID');

    if (record.status === 'revoked') {
      const observed = await this.persistence.observeLogout(record);
      if (observed.kind === 'audit_failed') throw new LogoutClearableError('SERVICE_UNAVAILABLE');
      return;
    }
    if (record.status === 'expired') throw new AppError('CSRF_INVALID');
    if (record.status === 'rotated') {
      await this.commitTerminal(record, 'reuse', now);
      throw new SessionResolutionError('AUTH_SESSION_REUSED', true);
    }
    if (record.user.status === 'disabled') {
      await this.commitTerminal(record, 'disabled', now);
      return;
    }
    if (now >= record.idleExpiresAt || now >= record.absoluteExpiresAt) {
      throw new AppError('CSRF_INVALID');
    }
    await this.commitTerminal(record, 'logout', now);
  }

  private assertSignatureOnlyCsrf(
    csrfCookie: string | undefined,
    csrfHeader: string | undefined,
    now: number,
  ): void {
    if (
      csrfCookie === undefined
      || csrfHeader === undefined
      || !this.csrf.constantTimeEqual(csrfCookie, csrfHeader)
      || !this.csrf.verifyAnySignature(csrfCookie, now)
    ) throw new AppError('CSRF_INVALID');
  }

  private async commitTerminal(
    record: SessionRecord,
    reason: 'logout' | 'reuse' | 'disabled',
    now: number,
  ): Promise<void> {
    const result = await this.persistence.terminalizeFamily(record, reason, now);
    if (result.kind === 'audit_failed') throw new AppError('SERVICE_UNAVAILABLE');
  }
}
