import { Body, Controller, Get, HttpCode, Inject, Post, Req, Res } from '@nestjs/common';

import {
  parseAuthCredentials,
  parseGoogleIdTokenRequest,
  parseEmailVerificationConfirmation,
  parseEmailVerificationRequest,
  parseEmptyObject,
  parsePasswordChangeRequest,
  parseSignupCredentials,
  type AuthCredentials,
} from './auth.dto.js';
import { CookieService } from './cookie.service.js';
import { CsrfService } from './csrf.service.js';
import {
  SessionResolutionError,
  SessionService,
  type SessionControllerService,
  type SessionRecord,
} from './session.service.js';
import type { AuthSessionResponse, IssuedAuthSession } from './auth.service.js';
import { AppError } from '../common/errors/app-error.js';
import { RequireCsrf } from '../common/guards/csrf.guard.js';
import { RequireSession } from '../common/guards/authentication.guard.js';
import { RequireOrigin } from '../common/guards/origin.guard.js';
import {
  LogoutClearableError,
  LogoutService,
  type LogoutControllerService,
} from './logout.service.js';
import { D2RateLimited } from '../rate-limit/d2-rate-limit.guards.js';
import {
  EmailVerificationService,
  type EmailVerificationConfirmed,
  type EmailVerificationRequested,
} from './email-verification.service.js';
import { PasswordChangeService } from './password-change.service.js';

export const AUTH_CONTROLLER_SERVICE = Symbol('AUTH_CONTROLLER_SERVICE');

export interface AuthControllerService {
  signup(credentials: AuthCredentials, now: number): Promise<IssuedAuthSession>;
  login(
    credentials: AuthCredentials,
    now: number,
    signal?: AbortSignal,
  ): Promise<IssuedAuthSession>;
  google?(idToken: string, now: number): Promise<IssuedAuthSession>;
}

export interface AuthHttpRequest {
  cookies?: Record<string, string | undefined> | undefined;
  headers?: Record<string, string | string[] | undefined> | undefined;
}

export interface AuthenticatedAuthHttpRequest extends AuthHttpRequest {
  authSession?: SessionRecord | undefined;
}

export interface AuthHttpResponse {
  setHeader(name: string, value: string): AuthHttpResponse;
  appendHeader(name: string, value: string): AuthHttpResponse;
}

const setAuthHeaders = (response: AuthHttpResponse): void => {
  response.setHeader('Cache-Control', 'no-store, private');
  response.setHeader('Pragma', 'no-cache');
  response.setHeader('Vary', 'Origin, Cookie');
};

@Controller('api/v1/auth')
export class AuthController {
  constructor(
    @Inject(AUTH_CONTROLLER_SERVICE) private readonly auth: AuthControllerService,
    @Inject(SessionService) private readonly sessions: SessionControllerService,
    @Inject(CsrfService) private readonly csrfTokens: CsrfService,
    @Inject(CookieService) private readonly cookies: CookieService,
    @Inject(LogoutService) private readonly logoutService: LogoutControllerService,
    @Inject(EmailVerificationService) private readonly emailVerification: EmailVerificationService,
    @Inject(PasswordChangeService) private readonly passwordChanges: PasswordChangeService,
  ) {}

  @Get('csrf')
  @HttpCode(200)
  @D2RateLimited('csrf-bootstrap')
  csrf(
    @Req() request: AuthHttpRequest,
    @Res({ passthrough: true }) response: AuthHttpResponse,
    now: number = Date.now(),
  ): { csrfToken: string; expiresAt: string } {
    if (request.cookies?.[this.cookies.names.session] !== undefined)
      throw new AppError('AUTH_SESSION_PRESENT');
    const issued = this.csrfTokens.issueAnonymous(now);
    const maxAgeSeconds = Math.max(0, Math.floor((issued.expiresAt - now) / 1_000));
    response.appendHeader('Set-Cookie', this.cookies.csrf(issued.token, maxAgeSeconds));
    response.setHeader(
      'X-Auth-Generation',
      this.csrfTokens.authGeneration('a', null, issued.token),
    );
    setAuthHeaders(response);
    return { csrfToken: issued.token, expiresAt: new Date(issued.expiresAt).toISOString() };
  }

  @Post('signup')
  @HttpCode(201)
  @RequireCsrf('anonymous')
  @D2RateLimited('signup')
  async signup(
    @Body() input: unknown,
    @Res({ passthrough: true }) response: AuthHttpResponse,
    now: number = Date.now(),
  ): Promise<AuthSessionResponse> {
    const parsed = parseSignupCredentials(input);
    this.emailVerification.assertTicket(parsed.emailNormalized, parsed.verificationTicket, now);
    const { verificationTicket: _verificationTicket, ...credentials } = parsed;
    const issued = await this.auth.signup(credentials, now);
    this.writeIssuedSession(response, issued);
    return issued.response;
  }

  @Post('email-verifications')
  @HttpCode(202)
  @RequireOrigin()
  @D2RateLimited('email-verification-request')
  async requestEmailVerification(@Body() input: unknown): Promise<EmailVerificationRequested> {
    return this.emailVerification.request(parseEmailVerificationRequest(input));
  }

  @Post('email-verifications/confirm')
  @HttpCode(200)
  @RequireOrigin()
  @D2RateLimited('email-verification-confirm')
  async confirmEmailVerification(
    @Body() input: unknown,
    now: number = Date.now(),
  ): Promise<EmailVerificationConfirmed> {
    return this.emailVerification.confirm(parseEmailVerificationConfirmation(input), now);
  }

  @Post('login')
  @HttpCode(200)
  @RequireCsrf('anonymous')
  @D2RateLimited('login')
  async login(
    @Body() input: unknown,
    @Res({ passthrough: true }) response: AuthHttpResponse,
    now: number = Date.now(),
  ): Promise<AuthSessionResponse> {
    const issued = await this.auth.login(parseAuthCredentials(input), now);
    this.writeIssuedSession(response, issued);
    return issued.response;
  }

  @Post('google')
  @HttpCode(200)
  @RequireCsrf('anonymous')
  @D2RateLimited('google-login')
  async google(
    @Body() input: unknown,
    @Res({ passthrough: true }) response: AuthHttpResponse,
    now: number = Date.now(),
  ): Promise<AuthSessionResponse> {
    if (this.auth.google === undefined) throw new AppError('SERVICE_UNAVAILABLE');
    const issued = await this.auth.google(parseGoogleIdTokenRequest(input).idToken, now);
    this.writeIssuedSession(response, issued);
    return issued.response;
  }

  @Post('password')
  @HttpCode(204)
  @RequireSession()
  @RequireCsrf('session')
  @D2RateLimited('password-change')
  async changePassword(
    @Body() input: unknown,
    @Req() request: AuthenticatedAuthHttpRequest,
    @Res({ passthrough: true }) response: AuthHttpResponse,
    now: number = Date.now(),
  ): Promise<void> {
    if (request.authSession === undefined) throw new AppError('UNAUTHENTICATED');
    await this.passwordChanges.change(request.authSession, parsePasswordChangeRequest(input), now);
    setAuthHeaders(response);
  }

  @Get('session')
  @HttpCode(200)
  async session(
    @Req() request: AuthHttpRequest,
    @Res({ passthrough: true }) response: AuthHttpResponse,
    now: number = Date.now(),
  ): Promise<AuthSessionResponse> {
    try {
      const resolved = await this.sessions.resolveExclusive(
        request.cookies?.[this.cookies.names.session],
        request.cookies?.[this.cookies.names.csrf],
        now,
      );
      if (resolved.csrfWasReissued) {
        response.appendHeader(
          'Set-Cookie',
          this.cookies.csrf(resolved.response.csrfToken, resolved.csrfMaxAgeSeconds),
        );
      }
      response.setHeader('X-Auth-Generation', resolved.authGeneration);
      setAuthHeaders(response);
      return resolved.response;
    } catch (error) {
      if (error instanceof SessionResolutionError && error.clearCookies) {
        for (const cookie of this.cookies.clear()) response.appendHeader('Set-Cookie', cookie);
        response.setHeader('X-Auth-Generation', 'cleared');
        setAuthHeaders(response);
      }
      throw error;
    }
  }

  @Post('session/renew')
  @HttpCode(200)
  @RequireOrigin()
  @D2RateLimited('session-renewal')
  async renew(
    @Body() input: unknown,
    @Req() request: AuthHttpRequest,
    @Res({ passthrough: true }) response: AuthHttpResponse,
    now: number = Date.now(),
  ): Promise<AuthSessionResponse> {
    parseEmptyObject(input);
    const csrfCookie = request.cookies?.[this.cookies.names.csrf];
    const csrfHeader = oneHeader(request, 'x-csrf-token');
    if (
      csrfCookie === undefined ||
      csrfHeader === undefined ||
      !this.csrfTokens.constantTimeEqual(csrfCookie, csrfHeader)
    )
      throw new AppError('CSRF_INVALID');

    try {
      const issued = await this.sessions.renew(
        request.cookies?.[this.cookies.names.session],
        csrfCookie,
        now,
      );
      this.writeIssuedSession(response, issued);
      return issued.response;
    } catch (error) {
      this.clearCommittedTerminal(response, error);
      throw error;
    }
  }

  @Post('logout')
  @HttpCode(204)
  @RequireOrigin()
  async logout(
    @Body() input: unknown,
    @Req() request: AuthHttpRequest,
    @Res({ passthrough: true }) response: AuthHttpResponse,
    now: number = Date.now(),
  ): Promise<void> {
    parseEmptyObject(input);
    try {
      await this.logoutService.logout(
        request.cookies?.[this.cookies.names.session],
        request.cookies?.[this.cookies.names.csrf],
        oneHeader(request, 'x-csrf-token'),
        now,
      );
      this.writeClearedSession(response);
    } catch (error) {
      if (
        error instanceof LogoutClearableError ||
        (error instanceof SessionResolutionError && error.clearCookies)
      ) {
        this.writeClearedSession(response);
      }
      throw error;
    }
  }

  private writeIssuedSession(response: AuthHttpResponse, issued: IssuedAuthSession): void {
    response.appendHeader(
      'Set-Cookie',
      this.cookies.session(issued.sessionCredential, issued.sessionMaxAgeSeconds),
    );
    response.appendHeader(
      'Set-Cookie',
      this.cookies.csrf(issued.response.csrfToken, issued.csrfMaxAgeSeconds),
    );
    response.setHeader('X-Auth-Generation', issued.authGeneration);
    setAuthHeaders(response);
  }

  private clearCommittedTerminal(response: AuthHttpResponse, error: unknown): void {
    if (!(error instanceof SessionResolutionError) || !error.clearCookies) return;
    this.writeClearedSession(response);
  }

  private writeClearedSession(response: AuthHttpResponse): void {
    for (const cookie of this.cookies.clear()) response.appendHeader('Set-Cookie', cookie);
    response.setHeader('X-Auth-Generation', 'cleared');
    setAuthHeaders(response);
  }
}

const oneHeader = (request: AuthHttpRequest, name: string): string | undefined => {
  const value = request.headers?.[name];
  return typeof value === 'string' ? value : undefined;
};
