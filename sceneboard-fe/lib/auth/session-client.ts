'use client';

import {
  parseEmailVerificationConfirmed,
  parseEmailVerificationRequested,
  parsePublicApiError,
  type AuthSessionSnapshot,
  type EmailVerificationConfirmed,
  type EmailVerificationRequested,
} from '../api/auth-contracts';
import type { Locale } from '../i18n/catalog';
import {
  browserSessionCoordinator,
  type CoordinatorResult,
  type SessionRequestCoordinator,
} from './renewal-singleflight';

export class AuthSessionClient {
  constructor(private readonly coordinator: SessionRequestCoordinator) {}

  reconcile(): Promise<CoordinatorResult<AuthSessionSnapshot | null>> {
    return this.coordinator.reconcileSessionGeneration();
  }

  signup(email: string, password: string, verificationTicket: string) {
    return this.coordinator.authenticate('signup', { email, password, verificationTicket });
  }

  login(email: string, password: string) {
    return this.coordinator.authenticate('login', { email, password });
  }

  loginWithGoogle(idToken: string) {
    return this.coordinator.authenticate('google', { idToken });
  }

  async changePassword(
    currentPassword: string,
    newPassword: string,
  ): Promise<PasswordChangeClientResult> {
    const csrfToken = this.coordinator.currentSnapshot()?.csrfToken;
    if (csrfToken === undefined) return { kind: 'reconciliation_required' };
    const dispatched = await this.coordinator.dispatchShared({
      path: '/api/v1/auth/password',
      method: 'POST',
      body: { currentPassword, newPassword },
      csrfToken,
    });
    if (dispatched.kind !== 'ok') return dispatched;
    if (dispatched.value.response.status === 204 && dispatched.value.body === null) {
      return { kind: 'ok', value: null };
    }
    try {
      const parsed = parsePublicApiError(dispatched.value.body);
      return {
        kind: 'api_error',
        status: dispatched.value.response.status,
        code: parsed.error.code,
      };
    } catch {
      return { kind: 'corrupt_response' };
    }
  }

  requestEmailVerification(
    email: string,
    locale: Locale,
  ): Promise<EmailVerificationClientResult<EmailVerificationRequested>> {
    return this.emailVerificationRequest(
      '/api/v1/auth/email-verifications',
      202,
      { email, locale },
      parseEmailVerificationRequested,
    );
  }

  confirmEmailVerification(
    email: string,
    code: string,
  ): Promise<EmailVerificationClientResult<EmailVerificationConfirmed>> {
    return this.emailVerificationRequest(
      '/api/v1/auth/email-verifications/confirm',
      200,
      { email, code },
      parseEmailVerificationConfirmed,
    );
  }

  renew(): Promise<CoordinatorResult<AuthSessionSnapshot>> {
    return this.coordinator.renewSession();
  }

  logout(): Promise<CoordinatorResult<null>> {
    return this.coordinator.logout();
  }

  snapshot(): AuthSessionSnapshot | null {
    return this.coordinator.currentSnapshot();
  }

  sharedCoordinator(): SessionRequestCoordinator {
    return this.coordinator;
  }

  private async emailVerificationRequest<Value>(
    path: string,
    successStatus: number,
    body: unknown,
    parse: (value: unknown) => Value,
  ): Promise<EmailVerificationClientResult<Value>> {
    const dispatched = await this.coordinator.dispatchShared({ path, method: 'POST', body });
    if (dispatched.kind !== 'ok') return dispatched;
    const consumed = dispatched.value;
    if (consumed.response.status === successStatus) {
      try {
        return { kind: 'ok', value: parse(consumed.body) };
      } catch {
        return { kind: 'corrupt_response' };
      }
    }
    try {
      const parsed = parsePublicApiError(consumed.body);
      const retryAfter = consumed.response.headers.get('retry-after');
      return {
        kind: 'api_error',
        status: consumed.response.status,
        code: parsed.error.code,
        retryAfterSeconds:
          retryAfter !== null && /^[1-9][0-9]*$/.test(retryAfter) ? Number(retryAfter) : null,
      };
    } catch {
      return { kind: 'corrupt_response' };
    }
  }
}

export type EmailVerificationClientResult<Value> =
  | CoordinatorResult<Value>
  | { kind: 'api_error'; status: number; code: string; retryAfterSeconds: number | null }
  | { kind: 'corrupt_response' };

export type PasswordChangeClientResult =
  | CoordinatorResult<null>
  | { kind: 'api_error'; status: number; code: string }
  | { kind: 'corrupt_response' };

let singleton: AuthSessionClient | null = null;

export const authSessionClient = (): AuthSessionClient => {
  if (singleton !== null) return singleton;
  const configured = process.env.NEXT_PUBLIC_BOARD_API_URL;
  if (configured === undefined) throw new TypeError('NEXT_PUBLIC_BOARD_API_URL is required');
  singleton = new AuthSessionClient(browserSessionCoordinator(configured));
  return singleton;
};
