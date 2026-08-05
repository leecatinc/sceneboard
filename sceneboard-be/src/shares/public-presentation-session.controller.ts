import { All, Body, Controller, Get, Inject, Param, Post, Req, Res } from '@nestjs/common';
import {
  PublicPresentationStartRequestParserV1,
  PublicPresentationUpdateRequestParserV1,
} from '@sceneboard/board-schema';

import { RequireOrigin } from '../common/guards/origin.guard.js';
import { D2RateLimited } from '../rate-limit/d2-rate-limit.guards.js';
import { RedisService } from '../redis/redis.service.js';
import { PublicShareHttpError } from './public-share.error.js';
import { PublicPresentationSessionService } from './public-presentation-session.service.js';
import { applyPublicProjectionHeaders } from './share-response-policy.js';

interface PublicPresentationRequest {
  headers: Record<string, string | string[] | undefined>;
  once(event: 'close', listener: () => void): unknown;
  off(event: 'close', listener: () => void): unknown;
}

interface PublicPresentationResponse {
  statusCode: number;
  headersSent: boolean;
  httpVersionMajor?: number | undefined;
  setHeader(name: string, value: string | readonly string[]): unknown;
  removeHeader(name: string): unknown;
  flushHeaders?(): unknown;
  status(code: number): PublicPresentationResponse;
  json(value: unknown): unknown;
  write(chunk: Uint8Array): boolean;
  once(event: 'drain', listener: () => void): unknown;
  off(event: 'drain', listener: () => void): unknown;
  end(): unknown;
}

const header = (request: PublicPresentationRequest, name: string): string | undefined => {
  const value = request.headers[name];
  if (Array.isArray(value)) throw new PublicShareHttpError(400);
  return value;
};

const write = async (response: PublicPresentationResponse, bytes: Uint8Array): Promise<void> => {
  if (response.write(bytes)) return;
  await new Promise<void>((resolve, reject) => {
    const onDrain = (): void => {
      clearTimeout(timeout);
      resolve();
    };
    const timeout = setTimeout(() => {
      response.off('drain', onDrain);
      reject(new PublicShareHttpError(503));
    }, 5_000);
    timeout.unref();
    response.once('drain', onDrain);
  });
};

const eventFrame = (value: unknown, version: number): Buffer =>
  Buffer.from(
    `event: presentation.state.v1\nid: ${version}\ndata: ${JSON.stringify({
      type: 'presentation.state.v1',
      snapshot: value,
    })}\n\n`,
    'utf8',
  );

@Controller('api/v1/public/share-contexts/:contextId/presentation-sessions')
export class PublicPresentationSessionController {
  constructor(
    @Inject(PublicPresentationSessionService)
    private readonly sessions: PublicPresentationSessionService,
    @Inject(RedisService) private readonly redis: RedisService,
  ) {}

  @Get()
  @D2RateLimited('public-presentation-read')
  @RequireOrigin()
  async list(
    @Req() request: PublicPresentationRequest,
    @Res() response: PublicPresentationResponse,
    @Param('contextId') contextId: string,
  ): Promise<void> {
    const result = await this.sessions.list(contextId, header(request, 'cookie'));
    applyPublicProjectionHeaders(response, 200);
    response.status(200).json(result);
  }

  @Post()
  @D2RateLimited('public-presentation-start')
  @RequireOrigin()
  async start(
    @Req() request: PublicPresentationRequest,
    @Res() response: PublicPresentationResponse,
    @Param('contextId') contextId: string,
    @Body() body: unknown,
  ): Promise<void> {
    const parsed = PublicPresentationStartRequestParserV1.parse(body);
    if (!parsed.ok) throw new PublicShareHttpError(400);
    const cookieHeader = header(request, 'cookie');
    const result = await this.sessions.start({
      contextId,
      ...(cookieHeader === undefined ? {} : { cookieHeader }),
      currentPageId: parsed.data.value.currentPageId,
    });
    applyPublicProjectionHeaders(response, 201);
    response.status(201).json(result);
  }

  @Get(':sessionId')
  @D2RateLimited('public-presentation-read')
  @RequireOrigin()
  async get(
    @Req() request: PublicPresentationRequest,
    @Res() response: PublicPresentationResponse,
    @Param('contextId') contextId: string,
    @Param('sessionId') sessionId: string,
  ): Promise<void> {
    const cookieHeader = header(request, 'cookie');
    const result = await this.sessions.get({
      contextId,
      sessionId,
      ...(cookieHeader === undefined ? {} : { cookieHeader }),
    });
    applyPublicProjectionHeaders(response, 200);
    response.status(200).json(result);
  }

  @Post(':sessionId/state')
  @D2RateLimited('public-presentation-update')
  @RequireOrigin()
  async update(
    @Req() request: PublicPresentationRequest,
    @Res() response: PublicPresentationResponse,
    @Param('contextId') contextId: string,
    @Param('sessionId') sessionId: string,
    @Body() body: unknown,
  ): Promise<void> {
    const parsed = PublicPresentationUpdateRequestParserV1.parse(body);
    if (!parsed.ok) throw new PublicShareHttpError(400);
    const cookieHeader = header(request, 'cookie');
    const result = await this.sessions.update({
      contextId,
      sessionId,
      ...(cookieHeader === undefined ? {} : { cookieHeader }),
      update: parsed.data.value,
    });
    applyPublicProjectionHeaders(response, 200);
    response.status(200).json(result);
  }

  @Post(':sessionId/end')
  @D2RateLimited('public-presentation-update')
  @RequireOrigin()
  async end(
    @Req() request: PublicPresentationRequest,
    @Res() response: PublicPresentationResponse,
    @Param('contextId') contextId: string,
    @Param('sessionId') sessionId: string,
    @Body() body: unknown,
  ): Promise<void> {
    if (
      body === null ||
      typeof body !== 'object' ||
      Array.isArray(body) ||
      Object.keys(body as Record<string, unknown>).length !== 0
    )
      throw new PublicShareHttpError(400);
    const cookieHeader = header(request, 'cookie');
    const result = await this.sessions.end({
      contextId,
      sessionId,
      ...(cookieHeader === undefined ? {} : { cookieHeader }),
    });
    applyPublicProjectionHeaders(response, 200);
    response.status(200).json(result);
  }

  @Get(':sessionId/events')
  @D2RateLimited('public-presentation-read')
  @RequireOrigin()
  async events(
    @Req() request: PublicPresentationRequest,
    @Res() response: PublicPresentationResponse,
    @Param('contextId') contextId: string,
    @Param('sessionId') sessionId: string,
  ): Promise<void> {
    const cookieHeader = header(request, 'cookie');
    const authorized = await this.sessions.authorize(contextId, cookieHeader);
    const channel = this.sessions.channelForRoom(authorized.room, sessionId);
    let dirty = true;
    let stopped = false;
    let wake: (() => void) | null = null;
    const signal = (): void => wake?.();
    const onClose = (): void => {
      stopped = true;
      signal();
    };
    request.once('close', onClose);
    const unsubscribe = await this.redis.subscribe(channel, () => {
      dirty = true;
      signal();
    });
    try {
      response.statusCode = 200;
      response.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      response.setHeader('Cache-Control', 'private, no-store');
      response.setHeader('X-Accel-Buffering', 'no');
      response.setHeader('Vary', 'Cookie, Origin');
      response.removeHeader('Content-Length');
      if (response.httpVersionMajor === 1) response.setHeader('Connection', 'keep-alive');
      response.flushHeaders?.();
      const startedAt = Date.now();
      let lastVersion = -1;
      let lastKeepaliveAt = startedAt;
      while (!stopped && Date.now() - startedAt < 25_000) {
        if (dirty) {
          let current;
          try {
            current = await this.sessions.getAuthorized(authorized, sessionId);
          } catch (error) {
            if (error instanceof PublicShareHttpError && error.status === 404) break;
            throw error;
          }
          if (current.version >= lastVersion) {
            await write(response, eventFrame(current, current.version));
            lastVersion = current.version;
          }
          dirty = false;
        }
        if (Date.now() - lastKeepaliveAt >= 10_000) {
          await write(response, Buffer.from(': sceneboard-presentation-keepalive\n\n', 'ascii'));
          lastKeepaliveAt = Date.now();
        }
        await new Promise<void>((resolve) => {
          let settled = false;
          const finish = (): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            wake = null;
            resolve();
          };
          const timer = setTimeout(finish, 1_000);
          timer.unref();
          wake = finish;
          if (dirty) finish();
        });
      }
    } finally {
      stopped = true;
      signal();
      request.off('close', onClose);
      await unsubscribe().catch(() => undefined);
      if (response.headersSent) response.end();
    }
  }

  @All()
  unsupportedCollection(): never {
    throw new PublicShareHttpError(405);
  }

  @All(':sessionId')
  unsupportedSession(): never {
    throw new PublicShareHttpError(405);
  }
}
