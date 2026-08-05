import { Catch, Inject, Optional, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';

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
import { PublicShareHttpError } from '../../shares/public-share.error.js';
import {
  applyPublicArtifactHeaders,
  applyPublicMediaHeaders,
  applyPublicProjectionHeaders,
  publicFailureBody,
} from '../../shares/share-response-policy.js';
import { applyAccountMediaErrorHeaders } from '../../media/media-response-policy.js';
import { ShareAnalyticsError } from '../errors/share-analytics.error.js';
import { ExportFailureV1 } from '../../exports/export-errors.js';
import {
  BACKEND_ERROR_SINK_OBSERVER_V1,
  dispatchBackendSecretSinkV1,
  productionBackendErrorSinkObserverV1,
  type SecretSinkObserverV1,
} from '../security/secret-sink-observability.js';

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

const isSharePath = (url: string): boolean =>
  /^\/api\/v1\/boards\/[^/?]+\/shares(?:\/|\?|$)/u.test(url) ||
  /^\/api\/v1\/boards\/[^/?]+\/presentation-sessions(?:\/|\?|$)/u.test(url) ||
  /^\/api\/v1\/public\/shares\/[^/?]+\/password-sessions(?:\?|$)/u.test(url);

const isPublicProjectionPath = (url: string): boolean =>
  /^\/api\/v1\/public\/(?:shares\/[^/?]+|share-contexts\/[^/?]+(?:\/presentation-sessions(?:\/[^/?]+(?:\/(?:state|end|events))?)?)?)(?:\?|$)/u.test(
    url,
  );

const isPublicArtifactPath = (url: string): boolean =>
  /^\/api\/v1\/public\/shares\/[^/?]+\/revisions\/[^/?]+\/g\/[^/?]+\/[^/?]+\/artifacts\/[^/?]+\/versions\/[^/?]+\/package(?:\?|$)/u.test(
    url,
  );

const isPublicMediaPath = (url: string): boolean =>
  /^\/api\/v1\/public\/shares\/[^/?]+\/revisions\/[^/?]+\/g\/[^/?]+\/[^/?]+\/media\/[^/?]+(?:\?|$)/u.test(
    url,
  );

const isAccountMediaPath = (url: string): boolean =>
  /^\/api\/v1\/boards\/[^/?]+\/revisions\/[^/?]+\/media\/[^/?]+(?:\?|$)/u.test(url);

const isShareAnalyticsPath = (url: string): boolean =>
  /^\/api\/v1\/public\/(?:shares\/[^/?]+\/view-contexts|share-view-events)(?:\?|$)/u.test(url) ||
  /^\/api\/v1\/boards\/[^/?]+\/share-analytics(?:\?|$)/u.test(url);

const isExportPath = (url: string): boolean =>
  /^\/api\/v1\/boards\/[^/?]+\/exports(?:\?|$)/u.test(url);

const exportFailure = (exception: unknown): ExportFailureV1 => {
  if (exception instanceof ExportFailureV1) return exception;
  if (exception instanceof BoardContractError) {
    if (exception.boardError.code === 'UNAUTHENTICATED')
      return new ExportFailureV1('EXPORT_UNAUTHENTICATED');
    if (exception.boardError.code === 'FORBIDDEN') return new ExportFailureV1('EXPORT_FORBIDDEN');
    if (exception.boardError.code === 'BOARD_NOT_FOUND')
      return new ExportFailureV1('EXPORT_NOT_FOUND');
    if (exception.boardError.code === 'RATE_LIMITED')
      return new ExportFailureV1('EXPORT_RATE_LIMITED');
    if (exception.boardError.code === 'SERVICE_UNAVAILABLE')
      return new ExportFailureV1('EXPORT_RENDERER_UNAVAILABLE');
    return new ExportFailureV1('EXPORT_INTERNAL_ERROR');
  }
  if (exception instanceof AppError) {
    if (
      exception.code === 'UNAUTHENTICATED' ||
      exception.code === 'AUTH_SESSION_EXPIRED' ||
      exception.code === 'AUTH_SESSION_REVOKED' ||
      exception.code === 'AUTH_SESSION_REUSED' ||
      exception.code === 'AUTH_INVALID_CREDENTIALS'
    )
      return new ExportFailureV1('EXPORT_UNAUTHENTICATED');
    if (exception.code === 'CSRF_INVALID') return new ExportFailureV1('EXPORT_FORBIDDEN');
    if (exception.code === 'INVALID_PAYLOAD') return new ExportFailureV1('EXPORT_INVALID_REQUEST');
    if (exception.code === 'RATE_LIMITED') return new ExportFailureV1('EXPORT_RATE_LIMITED');
    if (exception.code === 'SERVICE_UNAVAILABLE')
      return new ExportFailureV1('EXPORT_RENDERER_UNAVAILABLE');
  }
  return new ExportFailureV1('EXPORT_INTERNAL_ERROR');
};

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

const sourceRetryAfterSeconds = (exception: unknown): number | null => {
  if (exception instanceof BoardContractError) return retryAfterSeconds(exception.boardError);
  if (
    exception instanceof AppError &&
    (exception.code === 'RATE_LIMITED' || exception.code === 'SERVICE_UNAVAILABLE')
  )
    return exception.retryAfterSeconds;
  return null;
};

@Catch()
export class HttpErrorFilter implements ExceptionFilter {
  private readonly errorSinkObserver: SecretSinkObserverV1;

  constructor(
    @Inject(CryptoService) private readonly crypto: CryptoService,
    @Optional()
    @Inject(BACKEND_ERROR_SINK_OBSERVER_V1)
    errorSinkObserver?: SecretSinkObserverV1,
  ) {
    this.errorSinkObserver = errorSinkObserver ?? productionBackendErrorSinkObserverV1;
  }

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

    if (isExportPath(request.url ?? '')) {
      const failure = exportFailure(exception);
      if (
        failure.code === 'EXPORT_RATE_LIMITED' ||
        failure.code === 'EXPORT_RENDERER_UNAVAILABLE'
      ) {
        const retryAfter = sourceRetryAfterSeconds(exception);
        response.setHeader(
          'Retry-After',
          String(Math.max(1, Math.ceil(retryAfter === null ? 1 : retryAfter))),
        );
      }
      response.status(failure.httpStatus).json(failure.toPayload());
      return;
    }

    if (isShareAnalyticsPath(request.url ?? '')) {
      const analyticsError =
        exception instanceof ShareAnalyticsError
          ? exception
          : exception instanceof BoardContractError &&
              exception.boardError.code === 'UNAUTHENTICATED'
            ? new ShareAnalyticsError('UNAUTHENTICATED')
            : exception instanceof AppError && exception.code === 'UNAUTHENTICATED'
              ? new ShareAnalyticsError('UNAUTHENTICATED')
              : exception instanceof AppError && exception.code === 'INVALID_PAYLOAD'
                ? new ShareAnalyticsError('INVALID_PAYLOAD')
                : exception instanceof AppError && exception.code === 'CSRF_INVALID'
                  ? new ShareAnalyticsError('CSRF_INVALID')
                  : exception instanceof AppError && exception.code === 'RATE_LIMITED'
                    ? new ShareAnalyticsError('RATE_LIMITED', exception.retryAfterSeconds)
                    : new ShareAnalyticsError('SERVICE_UNAVAILABLE');
      if (analyticsError.retryAfterSeconds !== null)
        response.setHeader('Retry-After', String(analyticsError.retryAfterSeconds));
      response.status(analyticsError.status).json({
        error: {
          code: analyticsError.code,
          message: analyticsError.message,
          requestId,
        },
      });
      return;
    }

    if (
      isPublicProjectionPath(request.url ?? '') ||
      isPublicArtifactPath(request.url ?? '') ||
      isPublicMediaPath(request.url ?? '')
    ) {
      const publicError =
        exception instanceof PublicShareHttpError
          ? exception
          : exception instanceof AppError && exception.code === 'INVALID_PAYLOAD'
            ? new PublicShareHttpError(400, null)
            : exception instanceof AppError && exception.code === 'RATE_LIMITED'
              ? new PublicShareHttpError(429, exception.retryAfterSeconds)
              : exception instanceof AppError && exception.code === 'SERVICE_UNAVAILABLE'
                ? new PublicShareHttpError(503)
                : new PublicShareHttpError(503);
      if (isPublicArtifactPath(request.url ?? ''))
        applyPublicArtifactHeaders(response, publicError.status, publicError.contentRangeLength);
      else if (isPublicMediaPath(request.url ?? ''))
        applyPublicMediaHeaders(response, publicError.status, {
          contentRangeLength: publicError.contentRangeLength,
        });
      else applyPublicProjectionHeaders(response, publicError.status);
      if (publicError.retryAfterSeconds !== null)
        response.setHeader('Retry-After', String(Math.ceil(publicError.retryAfterSeconds)));
      response
        .status(publicError.status)
        .json(publicFailureBody(publicError.status, publicError.retryAfterSeconds));
      return;
    }

    if (isSharePath(request.url ?? '')) {
      const shareError =
        exception instanceof ShareContractError
          ? exception
          : exception instanceof AppError && exception.code === 'INVALID_PAYLOAD'
            ? new ShareContractError('INVALID_REQUEST')
            : exception instanceof AppError && exception.status === 401
              ? new ShareContractError('UNAUTHENTICATED')
              : exception instanceof AppError && exception.code === 'RATE_LIMITED'
                ? new ShareContractError('RATE_LIMITED', exception.retryAfterSeconds)
                : exception instanceof AppError && exception.code === 'SERVICE_UNAVAILABLE'
                  ? new ShareContractError('SERVICE_UNAVAILABLE', 1)
                  : new ShareContractError('BOARD_NOT_FOUND');
      if (shareError.retryAfterSeconds !== null) {
        response.setHeader(
          'Retry-After',
          String(Math.max(1, Math.ceil(shareError.retryAfterSeconds))),
        );
      }
      const errorBody: Record<string, unknown> = {
        code: shareError.code,
        message: shareError.message,
        requestId,
      };
      if (shareError.reason !== null) errorBody.details = { reason: shareError.reason };
      response.status(shareError.status).json({ error: errorBody });
      return;
    }

    if (exception instanceof BoardContractError) {
      if (isAccountMediaPath(request.url ?? ''))
        applyAccountMediaErrorHeaders(response, exception.status);
      const retryAfter = retryAfterSeconds(exception.boardError);
      if (retryAfter !== null)
        response.setHeader('Retry-After', String(Math.max(1, Math.ceil(retryAfter))));
      response.status(exception.status).json({ error: exception.boardError });
      return;
    }

    const error = exception instanceof AppError ? exception : new AppError('INTERNAL_ERROR');
    dispatchBackendSecretSinkV1({
      sink: 'ERROR',
      rawPayload: {},
      observer: this.errorSinkObserver,
    });
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
    dispatchBackendSecretSinkV1({
      sink: 'HTTP_RESPONSE_OR_URL',
      rawPayload: error.toPayload(),
      observer: { observe: () => {} },
    });
    response.status(error.status).json({ error: error.toPayload() });
  }
}
