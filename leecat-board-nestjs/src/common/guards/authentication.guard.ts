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
import { AppError } from '../errors/app-error.js';

const SESSION_REQUIRED = Symbol('SESSION_REQUIRED');

export const RequireSession = (): MethodDecorator & ClassDecorator => SetMetadata(SESSION_REQUIRED, true);

export interface AuthenticatedRequest {
  headers: Record<string, string | string[] | undefined>;
  cookies?: Record<string, string | undefined> | undefined;
  authSession?: SessionRecord | undefined;
}

@Injectable()
export class AuthenticationGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(SessionService) private readonly sessions: SessionService,
    @Inject(CookieService) private readonly cookies: CookieService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<boolean | undefined>(SESSION_REQUIRED, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (required !== true) return true;
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const credential = request.cookies?.[this.cookies.names.session];
    if (credential !== undefined && request.headers.authorization !== undefined) {
      throw new AppError('UNAUTHENTICATED');
    }
    request.authSession = await this.sessions.resolveShared(credential, Date.now());
    return true;
  }
}
