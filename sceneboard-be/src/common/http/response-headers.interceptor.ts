import {
  Inject,
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import type { Observable } from 'rxjs';
import { tap } from 'rxjs';

import { CryptoService } from '../security/crypto.service.js';
import {
  admittedBoardRequestId,
  type BoardRequestCorrelationCarrier,
} from './board-request-correlation.js';

interface HeaderRequest extends BoardRequestCorrelationCarrier {
  url?: string | undefined;
}

interface HeaderResponse {
  setHeader(name: string, value: string): unknown;
}

export const applyPrivateResponseHeaders = (url: string, response: HeaderResponse): void => {
  if (/^\/api\/v1\/(?:auth|pairings|grants|boards|mcp|account\/api-keys)(?:\/|\?|$)/.test(url)) {
    response.setHeader('Cache-Control', 'no-store, private');
    response.setHeader('Pragma', 'no-cache');
  }
  if (/^\/api\/v1\/(?:boards|mcp)(?:\/|\?|$)/.test(url)) {
    response.setHeader('Vary', 'Origin, Cookie, Authorization');
  } else if (/^\/api\/v1\/account\/api-keys(?:\/|\?|$)/.test(url)) {
    response.setHeader('Vary', 'Origin, Cookie');
  } else if (/^\/api\/v1\/pairings\/[^/?]+\/(?:client-status|redeem)(?:\?|$)/.test(url)) {
    response.setHeader('Vary', 'Authorization');
  } else if (
    /^\/api\/v1\/grants(?:\/|\?|$)/.test(url) ||
    (/^\/api\/v1\/pairings(?:\/|\?|$)/.test(url) &&
      !/^\/api\/v1\/pairings\/claim(?:\?|$)/.test(url))
  ) {
    response.setHeader('Vary', 'Origin, Cookie');
  }
};

@Injectable()
export class ResponseHeadersInterceptor implements NestInterceptor {
  constructor(@Inject(CryptoService) private readonly crypto: CryptoService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const request = http.getRequest<HeaderRequest>();
    const response = http.getResponse<HeaderResponse>();
    response.setHeader('X-Request-Id', this.crypto.generatePublicIdV1());
    applyPrivateResponseHeaders(request.url ?? '', response);
    return next.handle().pipe(
      tap((value) => {
        const admitted = admittedBoardRequestId(request);
        if (admitted !== null) response.setHeader('X-Request-Id', admitted);
        else if (
          value !== null &&
          typeof value === 'object' &&
          (value as { type?: unknown }).type === 'board.http.success' &&
          typeof (value as { requestId?: unknown }).requestId === 'string'
        ) {
          response.setHeader('X-Request-Id', (value as { requestId: string }).requestId);
        }
      }),
    );
  }
}
