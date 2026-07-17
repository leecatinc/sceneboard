import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { CookieService } from '../../auth/cookie.service.js';
import { SessionService, type SessionRecord } from '../../auth/session.service.js';
import { ActorContextService } from '../../grants/actor-context.service.js';
import type { ResolvedBoardPrincipalV1 } from '../../grants/board-access.policy.js';
import { AppError, BoardContractError } from '../errors/app-error.js';

const BOARD_PRINCIPAL_REQUIRED = Symbol('BOARD_PRINCIPAL_REQUIRED');

export const RequireBoardPrincipal = (): MethodDecorator & ClassDecorator => (
  SetMetadata(BOARD_PRINCIPAL_REQUIRED, true)
);

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
    const required = this.reflector.getAllAndOverride<boolean | undefined>(BOARD_PRINCIPAL_REQUIRED, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (required !== true) return true;
    const request = context.switchToHttp().getRequest<BoardPrincipalRequest>();
    const sessionCredential = request.cookies?.[this.cookies.names.session];
    const authorizationValue = request.headers.authorization;
    const authorization = typeof authorizationValue === 'string' ? authorizationValue : undefined;
    try {
      if ((sessionCredential !== undefined && authorizationValue !== undefined)
        || (sessionCredential === undefined && authorizationValue === undefined)
        || Array.isArray(authorizationValue)) {
        throw new AppError('UNAUTHENTICATED');
      }
      if (sessionCredential !== undefined) {
        const session = await this.sessions.resolveShared(sessionCredential, Date.now());
        request.authSession = session;
        request.boardPrincipal = this.actors.resolveUser(session);
        return true;
      }
      request.boardPrincipal = await this.actors.resolveMcp(authorization, Date.now());
      return true;
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      throw boardAuthFailure(error.code === 'SERVICE_UNAVAILABLE' ? 'SERVICE_UNAVAILABLE' : 'UNAUTHENTICATED');
    }
  }
}

const boardAuthFailure = (code: 'UNAUTHENTICATED' | 'SERVICE_UNAVAILABLE'): BoardContractError => (
  new BoardContractError(code === 'UNAUTHENTICATED' ? {
    protocolVersion: 1,
    type: 'board.error',
    code,
    message: 'Authentication is required',
    category: 'auth',
    retryable: false,
    httpStatusHint: 401,
    details: null,
  } : {
    protocolVersion: 1,
    type: 'board.error',
    code,
    message: 'Service unavailable',
    category: 'availability',
    retryable: true,
    httpStatusHint: 503,
    details: { retryAfterSeconds: null },
  })
);
