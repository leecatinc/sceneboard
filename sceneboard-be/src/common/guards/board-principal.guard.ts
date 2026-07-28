import { CanActivate, ExecutionContext, Inject, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { CookieService } from '../../auth/cookie.service.js';
import { SessionService, type SessionRecord } from '../../auth/session.service.js';
import { ActorContextService } from '../../grants/actor-context.service.js';
import type { ResolvedBoardPrincipalV1 } from '../../grants/board-access.policy.js';
import { AppError, BoardContractError } from '../errors/app-error.js';

const BOARD_PRINCIPAL_REQUIRED = Symbol('BOARD_PRINCIPAL_REQUIRED');

type BoardPrincipalMode = 'standard' | 'media-upload';

export const RequireBoardPrincipal = (
  mode: BoardPrincipalMode = 'standard',
): MethodDecorator & ClassDecorator => SetMetadata(BOARD_PRINCIPAL_REQUIRED, mode);

export interface BoardPrincipalRequest {
  headers: Record<string, string | string[] | undefined>;
  cookies?: Record<string, string | undefined> | undefined;
  authSession?: SessionRecord | undefined;
  boardPrincipal?: ResolvedBoardPrincipalV1 | undefined;
}

@Injectable()
export class BoardPrincipalGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(SessionService) private readonly sessions: SessionService,
    @Inject(CookieService) private readonly cookies: CookieService,
    @Inject(ActorContextService) private readonly actors: ActorContextService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const mode = this.reflector.getAllAndOverride<BoardPrincipalMode | undefined>(
      BOARD_PRINCIPAL_REQUIRED,
      [context.getHandler(), context.getClass()],
    );
    if (mode === undefined) return true;
    const request = context.switchToHttp().getRequest<BoardPrincipalRequest>();
    const sessionCredential = request.cookies?.[this.cookies.names.session];
    const authorizationValue = request.headers.authorization;
    const authorization = typeof authorizationValue === 'string' ? authorizationValue : undefined;
    try {
      const mixed = sessionCredential !== undefined && authorizationValue !== undefined;
      if (
        mixed ||
        (sessionCredential === undefined && authorizationValue === undefined) ||
        Array.isArray(authorizationValue)
      ) {
        if (mixed && mode === 'media-upload') throw boardForbidden();
        throw new AppError('UNAUTHENTICATED');
      }
      if (sessionCredential !== undefined) {
        if (mode === 'media-upload' && authorizationValue !== undefined) throw boardForbidden();
        const session = await this.sessions.resolveShared(sessionCredential, Date.now());
        request.authSession = session;
        request.boardPrincipal = this.actors.resolveUser(session);
        return true;
      }
      if (
        mode === 'media-upload' &&
        (request.headers.cookie !== undefined ||
          request.headers.origin !== undefined ||
          request.headers['x-csrf-token'] !== undefined)
      )
        throw boardForbidden();
      request.boardPrincipal = await this.actors.resolveMcp(authorization, Date.now());
      return true;
    } catch (error) {
      if (error instanceof BoardContractError) throw error;
      if (!(error instanceof AppError)) throw error;
      throw boardAuthFailure(
        error.code === 'SERVICE_UNAVAILABLE' ? 'SERVICE_UNAVAILABLE' : 'UNAUTHENTICATED',
      );
    }
  }
}

const boardForbidden = (): BoardContractError =>
  new BoardContractError({
    protocolVersion: 1,
    type: 'board.error',
    code: 'FORBIDDEN',
    message: 'Forbidden',
    category: 'auth',
    retryable: false,
    httpStatusHint: 403,
    details: null,
  });

const boardAuthFailure = (code: 'UNAUTHENTICATED' | 'SERVICE_UNAVAILABLE'): BoardContractError =>
  new BoardContractError(
    code === 'UNAUTHENTICATED'
      ? {
          protocolVersion: 1,
          type: 'board.error',
          code,
          message: 'Authentication is required',
          category: 'auth',
          retryable: false,
          httpStatusHint: 401,
          details: null,
        }
      : {
          protocolVersion: 1,
          type: 'board.error',
          code,
          message: 'Service unavailable',
          category: 'availability',
          retryable: true,
          httpStatusHint: 503,
          details: { retryAfterSeconds: null },
        },
  );
