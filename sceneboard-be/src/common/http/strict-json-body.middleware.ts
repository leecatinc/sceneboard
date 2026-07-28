import { randomBytes } from 'node:crypto';

import { Injectable, type NestMiddleware } from '@nestjs/common';

import { AppError } from '../errors/app-error.js';
import { ArtifactBrokerError } from '../errors/artifact-broker.error.js';
import { BoardContractError } from '../errors/app-error.js';
import { boardPayloadTooLarge } from '../errors/board-error.factory.js';
import {
  admitBoardRequestId,
  type BoardRequestCorrelationCarrier,
} from './board-request-correlation.js';
import {
  matchRawBodyProfile,
  parseProfiledBody,
  type RawBodyProfile,
} from './raw-body-profiles.js';

export const D1_RAW_BODY = Symbol('D1_RAW_BODY');
export const D1_PARSED_BODY = Symbol('D1_PARSED_BODY');

interface ProfiledRequest
  extends AsyncIterable<Uint8Array | string>, BoardRequestCorrelationCarrier {
  method?: string | undefined;
  url?: string | undefined;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
  destroy?(error?: Error): void;
  [D1_RAW_BODY]?: Buffer;
  [D1_PARSED_BODY]?: unknown;
}

type Next = (error?: unknown) => void;

const oneHeader = (request: ProfiledRequest, name: string): string | undefined => {
  const value = request.headers[name];
  if (Array.isArray(value)) throw new AppError('INVALID_PAYLOAD');
  return value;
};

const maximumReadBytes = (profile: RawBodyProfile): number => {
  if (profile.kind === 'd7-artifact-source-body') return 11_534_337;
  if (profile.kind === 'd7-artifact-network-body') return 8_193;
  if (profile.kind === 'd1-document-contract-body') return 33_554_433;
  if (profile.kind === 'd1-contract-body' || profile.kind === 'd1-adapter-body') return 1_048_577;
  if (profile.kind === 'd2-rest-json-body') return 65_537;
  return 1;
};

const artifactSourceTooLarge = (actualBytes: number, maximumBytes: number) => ({
  protocolVersion: 1 as const,
  type: 'board.error' as const,
  code: 'PAYLOAD_TOO_LARGE' as const,
  message: 'Payload is too large',
  category: 'validation' as const,
  retryable: false as const,
  httpStatusHint: 413 as const,
  details: { scope: 'artifact.total' as const, actualBytes, maximumBytes },
});

const readBody = async (request: ProfiledRequest, maximumBytes: number): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk);
    total += bytes.byteLength;
    if (total > maximumBytes) {
      const error = new AppError('INVALID_PAYLOAD');
      request.destroy?.(error);
      throw error;
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, total);
};

@Injectable()
export class StrictJsonBodyMiddleware implements NestMiddleware {
  async use(request: ProfiledRequest, _response: unknown, next: Next): Promise<void> {
    try {
      const method = request.method ?? '';
      const sourceUrl = request.url ?? '';
      const pathname = new URL(sourceUrl, 'http://sceneboard.internal').pathname;
      const contentTypeHint = request.headers['content-type'];
      const profile = matchRawBodyProfile(
        method,
        pathname,
        typeof contentTypeHint === 'string' ? contentTypeHint : undefined,
      );
      if (!profile) {
        next();
        return;
      }
      const contentType = oneHeader(request, 'content-type');
      const contentLength = oneHeader(request, 'content-length');
      const contentEncoding = oneHeader(request, 'content-encoding');
      if (
        profile.kind === 'd1-document-contract-body' &&
        contentEncoding !== undefined &&
        contentEncoding !== 'identity'
      ) {
        throw new BoardContractError({
          protocolVersion: 1,
          type: 'board.error',
          code: 'INVALID_PAYLOAD',
          message: 'Invalid payload',
          category: 'validation',
          retryable: false,
          httpStatusHint: 400,
          details: {
            path: [],
            issue: 'content encoding must be identity',
          },
        });
      }
      const declaredLength =
        contentLength !== undefined && /^(?:0|[1-9][0-9]*)$/.test(contentLength)
          ? Number(contentLength)
          : null;
      const maximumBytes = maximumReadBytes(profile);
      let body: Buffer;
      try {
        body =
          declaredLength !== null && declaredLength >= maximumBytes
            ? Buffer.alloc(0)
            : await readBody(request, maximumBytes);
      } catch (error) {
        if (
          profile.kind === 'd7-artifact-network-body' &&
          error instanceof AppError &&
          error.code === 'INVALID_PAYLOAD'
        ) {
          throw new ArtifactBrokerError('INVALID_REQUEST', randomBytes(16).toString('base64url'));
        }
        if (
          (profile.kind === 'd1-contract-body' ||
            profile.kind === 'd1-document-contract-body' ||
            profile.kind === 'd1-adapter-body' ||
            profile.kind === 'd7-artifact-source-body') &&
          error instanceof AppError &&
          error.code === 'INVALID_PAYLOAD'
        ) {
          throw new BoardContractError(
            profile.kind === 'd7-artifact-source-body'
              ? artifactSourceTooLarge(maximumBytes, maximumBytes - 1)
              : boardPayloadTooLarge(maximumBytes, maximumBytes - 1),
          );
        }
        throw error;
      }
      const parsed = parseProfiledBody(profile, {
        contentType,
        contentLength,
        contentEncoding,
        body,
      });
      if (parsed.kind === 'd2-rest-json-body') request.body = parsed.body;
      else if (
        parsed.kind === 'd1-contract-body' ||
        parsed.kind === 'd1-document-contract-body' ||
        parsed.kind === 'd1-adapter-body' ||
        parsed.kind === 'd7-artifact-source-body' ||
        parsed.kind === 'd7-artifact-network-body'
      ) {
        request[D1_RAW_BODY] = Buffer.from(parsed.rawBody);
        request[D1_PARSED_BODY] = parsed.parsedBody;
        if (parsed.kind === 'd1-contract-body' || parsed.kind === 'd1-document-contract-body') {
          const candidate = parsed.parsedBody as { requestId?: unknown };
          admitBoardRequestId(request, candidate.requestId);
        }
      }
      next();
    } catch (error) {
      next(error);
    }
  }
}
