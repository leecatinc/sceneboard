import { CanActivate, ExecutionContext, Inject, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { AppError } from '../errors/app-error.js';
import { APP_ENVIRONMENT, type AppEnvironment } from '../../config/env.schema.js';
import {
  isBrowserBoardPrincipal,
  type ResolvedBoardPrincipalV1,
} from '../../grants/board-access.policy.js';

const ORIGIN_REQUIRED = Symbol('ORIGIN_REQUIRED');
type OriginMode = 'required' | 'browser-or-mcp';

export const RequireOrigin = (mode: OriginMode = 'required'): MethodDecorator =>
  SetMetadata(ORIGIN_REQUIRED, mode);

export const assertAllowedOrigin = (origin: string | undefined, allowedOrigin: string): void => {
  if (origin !== allowedOrigin) throw new AppError('CSRF_INVALID');
};

export const assertAllowedOriginOrSameOriginFetch = (input: {
  origin: string | undefined;
  fetchSite: string | undefined;
  fetchMode: string | undefined;
  allowedOrigin: string;
}): void => {
  if (input.origin !== undefined) {
    assertAllowedOrigin(input.origin, input.allowedOrigin);
    return;
  }
  if (input.fetchSite !== 'same-origin' || input.fetchMode !== 'cors') {
    throw new AppError('CSRF_INVALID');
  }
};

interface OriginRequest {
  headers: Record<string, string | string[] | undefined>;
  boardPrincipal?: ResolvedBoardPrincipalV1 | undefined;
}

@Injectable()
export class OriginGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(APP_ENVIRONMENT) private readonly environment: AppEnvironment,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const mode = this.reflector.getAllAndOverride<OriginMode | undefined>(ORIGIN_REQUIRED, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (mode === undefined) return true;
    const request = context.switchToHttp().getRequest<OriginRequest>();
    if (request.boardPrincipal !== undefined && !isBrowserBoardPrincipal(request.boardPrincipal))
      return true;
    const origin = request.headers.origin;
    const fetchSite = request.headers['sec-fetch-site'];
    const fetchMode = request.headers['sec-fetch-mode'];
    assertAllowedOriginOrSameOriginFetch({
      origin: typeof origin === 'string' ? origin : undefined,
      fetchSite: typeof fetchSite === 'string' ? fetchSite : undefined,
      fetchMode: typeof fetchMode === 'string' ? fetchMode : undefined,
      allowedOrigin: this.environment.browserOrigin,
    });
    return true;
  }
}
