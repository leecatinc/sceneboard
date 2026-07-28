import { Catch, Inject, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';

import { AppError, BoardContractError, ShareContractError } from '../errors/app-error.js';
import { ArtifactBrokerError } from '../errors/artifact-broker.error.js';
import type { BoardError, BoardErrorV1 } from '@sceneboard/board-schema';
import { CryptoService } from '../security/crypto.service.js';
import {
  admittedBoardRequestId,
  boardRequestIdFromUrl,
  type BoardRequestCorrelationCarrier,
} from '../http/board-request-correlation.js';
import { applyPrivateResponseHeaders } from '../http/response-headers.interceptor.js';

interface HttpResponse {
  headersSent?: boolean;
  writableEnded?: boolean;
  destroyed?: boolean;
  setHeader(name: string, value: string): unknown;
  status(statusCode: number): HttpResponse;
  json(value: unknown): unknown;
}

interface HttpRequest extends BoardRequestCorrelationCarrier {
  url?: string | undefined;
}

const isShareManagementPath = (url: string): boolean =>
  /^\/api\/v1\/boards\/[^/?]+\/shares(?:\/|\?|$)/u.test(url);

const boardInternalError = (): BoardErrorV1 => ({
  protocolVersion: 1,
  type: 'board.error',
  code: 'INTERNAL_ERROR',
  message: 'Internal error',
  category: 'internal',
  retryable: false,
  httpStatusHint: 500,
  details: null,
});

const boardErrorFromAppError = (error: AppError): BoardErrorV1 => {
  if (error.code === 'INVALID_PAYLOAD') {
    return {
      protocolVersion: 1,
      type: 'board.error',
      code: 'INVALID_PAYLOAD',
      message: 'Invalid payload',
      category: 'validation',
      retryable: false,
      httpStatusHint: 400,
      details: { path: [], issue: 'invalid request' },
    };
  }
  if (
    error.code === 'UNAUTHENTICATED' ||
    error.code === 'AUTH_SESSION_EXPIRED' ||
    error.code === 'AUTH_SESSION_REVOKED' ||
    error.code === 'AUTH_SESSION_REUSED' ||
    error.code === 'AUTH_INVALID_CREDENTIALS'
  ) {
    return {
      protocolVersion: 1,
      type: 'board.error',
      code: 'UNAUTHENTICATED',
      message: 'Authentication is required',
      category: 'auth',
      retryable: false,
      httpStatusHint: 401,
      details: null,
    };
  }
  if (error.code === 'CSRF_INVALID') {
    return {
      protocolVersion: 1,
      type: 'board.error',
      code: 'FORBIDDEN',
      message: 'Forbidden',
      category: 'auth',
      retryable: false,
      httpStatusHint: 403,
      details: null,
    };
  }
  if (error.code === 'RATE_LIMITED') {
    return {
      protocolVersion: 1,
      type: 'board.error',
      code: 'RATE_LIMITED',
      message: 'Rate limited',
      category: 'rate_limit',
      retryable: true,
      httpStatusHint: 429,
      details: { retryAfterSeconds: Math.max(1, error.retryAfterSeconds ?? 1) },
    };
  }
  if (error.code === 'SERVICE_UNAVAILABLE') {
    return {
      protocolVersion: 1,
      type: 'board.error',
      code: 'SERVICE_UNAVAILABLE',
      message: 'Service unavailable',
      category: 'availability',
      retryable: true,
      httpStatusHint: 503,
      details: { retryAfterSeconds: error.retryAfterSeconds },
    };
  }
  return boardInternalError();
};

const retryAfterSeconds = (error: BoardError): number | null => {
  if (error.code === 'RATE_LIMITED') return error.details.retryAfterSeconds;
  if (error.code === 'SERVICE_UNAVAILABLE') return error.details.retryAfterSeconds;
  return null;
};

@Catch()
export class HttpErrorFilter implements ExceptionFilter {
  constructor(@Inject(CryptoService) private readonly crypto: CryptoService) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const response = http.getResponse<HttpResponse>();
    const request = http.getRequest<HttpRequest>();
    if (
      response.headersSent === true ||
      response.writableEnded === true ||
      response.destroyed === true
    )
      return;
    const requestId =
      admittedBoardRequestId(request) ??
      boardRequestIdFromUrl(request.url) ??
      this.crypto.generatePublicIdV1();
    response.setHeader('X-Request-Id', requestId);
    applyPrivateResponseHeaders(request.url ?? '', response);

    if (exception instanceof ArtifactBrokerError) {
      response.setHeader('X-Request-Id', exception.requestId);
      response.status(exception.status).json(exception.toPayload());
      return;
    }

    if (isShareManagementPath(request.url ?? '')) {
      if (exception instanceof AppError && exception.status === 401) {
        response.status(exception.status).json({ error: exception.toPayload() });
        return;
      }
      const shareError =
        exception instanceof ShareContractError
          ? exception
          : exception instanceof AppError && exception.code === 'INVALID_PAYLOAD'
            ? new ShareContractError('INVALID_REQUEST')
            : exception instanceof AppError && exception.code === 'RATE_LIMITED'
              ? new ShareContractError('RATE_LIMITED', exception.retryAfterSeconds)
              : new ShareContractError('BOARD_NOT_FOUND');
      if (shareError.retryAfterSeconds !== null) {
        response.setHeader(
          'Retry-After',
          String(Math.max(1, Math.ceil(shareError.retryAfterSeconds))),
        );
      }
      response.status(shareError.status).json({
        error: {
          code: shareError.code,
          message: shareError.message,
          requestId,
        },
      });
      return;
    }

    if (exception instanceof BoardContractError) {
      const retryAfter = retryAfterSeconds(exception.boardError);
      if (retryAfter !== null)
        response.setHeader('Retry-After', String(Math.max(1, Math.ceil(retryAfter))));
      response.status(exception.status).json({ error: exception.boardError });
      return;
    }

    const error = exception instanceof AppError ? exception : new AppError('INTERNAL_ERROR');
    if (
      error.code === 'INVITATION_NOT_FOUND' ||
      error.code === 'INVITATION_CONFLICT' ||
      error.code === 'INVITATION_GONE' ||
      error.code === 'MEMBERSHIP_CONFLICT'
    ) {
      response.status(error.status).json({ error: error.toPayload() });
      return;
    }
    if (/^\/api\/v1\/(?:boards|mcp)(?:\/|\?|$)/.test(request.url ?? '')) {
      const boardError = boardErrorFromAppError(error);
      const retryAfter = retryAfterSeconds(boardError);
      if (retryAfter !== null)
        response.setHeader('Retry-After', String(Math.max(1, Math.ceil(retryAfter))));
      response.status(boardError.httpStatusHint).json({ error: boardError });
      return;
    }
    if (error.retryAfterSeconds !== null) {
      const retryAfter = Math.max(1, Math.ceil(error.retryAfterSeconds));
      response.setHeader('Retry-After', String(retryAfter));
    }
    response.status(error.status).json({ error: error.toPayload() });
  }
}
