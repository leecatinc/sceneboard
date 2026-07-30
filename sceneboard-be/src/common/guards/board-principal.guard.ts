import { CanActivate, ExecutionContext, Inject, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { CookieService } from '../../auth/cookie.service.js';
import { SessionService, type SessionRecord } from '../../auth/session.service.js';
import { ActorContextService } from '../../grants/actor-context.service.js';
import {
  isBrowserBoardPrincipal,
  type ResolvedBoardPrincipalV1,
} from '../../grants/board-access.policy.js';
import { resolveClientIp } from '../security/client-ip.js';
import { APP_ENVIRONMENT, type AppEnvironment } from '../../config/env.schema.js';
import { AppError, BoardContractError } from '../errors/app-error.js';
import { selectBearerCredentialFamilyV1 } from './bearer-credential-family.js';

const BOARD_PRINCIPAL_REQUIRED = Symbol('BOARD_PRINCIPAL_REQUIRED');

type BoardPrincipalMode = 'standard' | 'media-upload';

export const RequireBoardPrincipal = (
  mode: BoardPrincipalMode = 'standard',
): MethodDecorator & ClassDecorator => SetMetadata(BOARD_PRINCIPAL_REQUIRED, mode);

export interface BoardPrincipalRequest {
  headers: Record<string, string | string[] | undefined>;
  rawHeaders?: string[] | undefined;
  cookies?: Record<string, string | undefined> | undefined;
  authSession?: SessionRecord | undefined;
  boardPrincipal?: ResolvedBoardPrincipalV1 | undefined;
  originalUrl?: string | undefined;
  socket?: { remoteAddress?: string | undefined } | undefined;
}

@Injectable()
export class BoardPrincipalGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(SessionService) private readonly sessions: SessionService,
    @Inject(CookieService) private readonly cookies: CookieService,
    @Inject(ActorContextService) private readonly actors: ActorContextService,
    @Inject(APP_ENVIRONMENT) private readonly environment: AppEnvironment,
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
    try {
      const mixed =
        authorizationValue !== undefined &&
        (sessionCredential !== undefined || request.headers.cookie !== undefined);
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
      const selected = selectBearerCredentialFamilyV1(request);
      if (mode === 'media-upload' && selected.family !== 'mcp_grant') throw boardForbidden();
      request.boardPrincipal =
        selected.family === 'mcp_grant'
          ? await this.actors.resolveMcp(`Bearer ${selected.token}`, Date.now())
          : await this.actors.resolveAccountApiKey(
              selected.token,
              {
                correlationId: correlationId(request),
                clientIp: clientIp(request, this.environment),
              },
              Date.now(),
            );
      if (mode === 'media-upload' && isBrowserBoardPrincipal(request.boardPrincipal))
        throw boardForbidden();
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

const recordRequestId = (value: unknown): string | null => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const requestId = (value as Record<string, unknown>).requestId;
  return typeof requestId === 'string' && /^[A-Za-z0-9_-]{1,128}$/u.test(requestId)
    ? requestId
    : null;
};

const correlationId = (request: BoardPrincipalRequest): string => {
  const carrier = request as BoardPrincipalRequest & { body?: unknown; query?: unknown };
  const direct = recordRequestId(carrier.body) ?? recordRequestId(carrier.query);
  if (direct !== null) return direct;
  try {
    const requestId =
      request.originalUrl === undefined
        ? null
        : new URL(request.originalUrl, 'http://sceneboard.internal').searchParams.get('requestId');
    return requestId !== null && /^[A-Za-z0-9_-]{1,128}$/u.test(requestId)
      ? requestId
      : 'request_unavailable';
  } catch {
    return 'request_unavailable';
  }
};

const clientIp = (request: BoardPrincipalRequest, environment: AppEnvironment): string => {
  const forwarded = request.headers['x-forwarded-for'];
  return resolveClientIp({
    socketAddress: request.socket?.remoteAddress ?? '127.0.0.1',
    xForwardedFor: typeof forwarded === 'string' ? forwarded : undefined,
    trustedProxyCidrs: environment.trustedProxyCidrs,
  }).address;
};

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
