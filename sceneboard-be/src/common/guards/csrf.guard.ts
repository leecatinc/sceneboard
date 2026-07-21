import { CanActivate, ExecutionContext, Inject, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { CookieService } from '../../auth/cookie.service.js';
import { CsrfService } from '../../auth/csrf.service.js';
import { AppError, BoardContractError } from '../errors/app-error.js';
import { APP_ENVIRONMENT, type AppEnvironment } from '../../config/env.schema.js';
import type { ResolvedBoardPrincipalV1 } from '../../grants/board-access.policy.js';

export type RequiredCsrfKind = 'anonymous' | 'session';
const CSRF_KIND = Symbol('CSRF_KIND');

export const RequireCsrf = (kind: RequiredCsrfKind): MethodDecorator =>
  SetMetadata(CSRF_KIND, kind);

export interface OriginCsrfInput {
  requiredKind: RequiredCsrfKind;
  allowedOrigin: string;
  origin: string | undefined;
  csrfCookie: string | undefined;
  csrfHeader: string | undefined;
  now: number;
  csrf: CsrfService;
  cookies: CookieService;
  familyPublicId?: string | undefined;
}

export const assertOriginAndCsrf = (input: OriginCsrfInput): void => {
  if (
    input.origin !== input.allowedOrigin ||
    input.csrfCookie === undefined ||
    input.csrfHeader === undefined ||
    !input.csrf.constantTimeEqual(input.csrfCookie, input.csrfHeader)
  )
    throw new AppError('CSRF_INVALID');
  const valid =
    input.requiredKind === 'anonymous'
      ? input.csrf.verify(input.csrfCookie, { kind: 'anonymous', now: input.now })
      : input.familyPublicId !== undefined &&
        input.csrf.verify(input.csrfCookie, {
          kind: 'session',
          familyPublicId: input.familyPublicId,
          now: input.now,
        });
  if (!valid) throw new AppError('CSRF_INVALID');
};

interface GuardRequest {
  headers: Record<string, string | string[] | undefined>;
  cookies?: Record<string, string | undefined> | undefined;
  authSession?: { familyPublicId: string } | undefined;
  boardPrincipal?: ResolvedBoardPrincipalV1 | undefined;
}

const oneHeader = (request: GuardRequest, name: string): string | undefined => {
  const value = request.headers[name];
  return typeof value === 'string' ? value : undefined;
};

@Injectable()
export class CsrfGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(APP_ENVIRONMENT) private readonly environment: AppEnvironment,
    @Inject(CsrfService) private readonly csrf: CsrfService,
    @Inject(CookieService) private readonly cookies: CookieService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredKind = this.reflector.getAllAndOverride<RequiredCsrfKind | undefined>(CSRF_KIND, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (requiredKind === undefined) return true;
    const request = context.switchToHttp().getRequest<GuardRequest>();
    if (request.boardPrincipal?.kind === 'mcp') return true;
    try {
      assertOriginAndCsrf({
        requiredKind,
        allowedOrigin: this.environment.browserOrigin,
        origin: oneHeader(request, 'origin'),
        csrfCookie: request.cookies?.[this.cookies.names.csrf],
        csrfHeader: oneHeader(request, 'x-csrf-token'),
        familyPublicId: request.authSession?.familyPublicId,
        now: Date.now(),
        csrf: this.csrf,
        cookies: this.cookies,
      });
    } catch (error) {
      if (request.boardPrincipal?.kind !== 'user' || !(error instanceof AppError)) throw error;
      throw new BoardContractError({
        protocolVersion: 1,
        type: 'board.error',
        code: 'FORBIDDEN',
        message: 'Forbidden',
        category: 'auth',
        retryable: false,
        httpStatusHint: 403,
        details: null,
      });
    }
    return true;
  }
}
