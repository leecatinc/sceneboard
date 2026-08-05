import { Body, Controller, Get, Inject, Param, Post, Query, Req, Res } from '@nestjs/common';
import {
  BoardIdParserV1,
  GlobalIdStringParserV1,
  PublicPresentationStartRequestParserV1,
  PublicPresentationUpdateRequestParserV1,
  type RevisionId,
} from '@sceneboard/board-schema';

import type { SessionRecord } from '../auth/session.service.js';
import { AppError, ShareContractError } from '../common/errors/app-error.js';
import {
  RequireBoardPrincipal,
  type BoardPrincipalRequest,
} from '../common/guards/board-principal.guard.js';
import { RequireCsrf } from '../common/guards/csrf.guard.js';
import { BoardOperationRateLimited } from '../rate-limit/board-operation-rate-limit.policy.js';
import { RedisService } from '../redis/redis.service.js';
import { OwnerPresentationSessionService } from './owner-presentation-session.service.js';
import { PublicPresentationSessionService } from './public-presentation-session.service.js';
import { PublicShareHttpError } from './public-share.error.js';

type OwnerRequest = BoardPrincipalRequest & {
  authSession?: SessionRecord | undefined;
  headers: Record<string, string | string[] | undefined>;
  once(event: 'close', listener: () => void): unknown;
  off(event: 'close', listener: () => void): unknown;
};

interface StreamResponse {
  statusCode: number;
  headersSent: boolean;
  httpVersionMajor?: number | undefined;
  setHeader(name: string, value: string | readonly string[]): unknown;
  removeHeader(name: string): unknown;
  flushHeaders?(): unknown;
  write(chunk: Uint8Array): boolean;
  once(event: 'drain', listener: () => void): unknown;
  off(event: 'drain', listener: () => void): unknown;
  end(): unknown;
}

const contract = (error: unknown): never => {
  if (!(error instanceof PublicShareHttpError)) throw error;
  if (error.status === 400) throw new ShareContractError('INVALID_REQUEST');
  if (error.status === 404) throw new ShareContractError('BOARD_NOT_FOUND');
  if (error.status === 409) throw new ShareContractError('SHARE_STATE_CONFLICT');
  if (error.status === 429) throw new ShareContractError('RATE_LIMITED', error.retryAfterSeconds);
  throw new ShareContractError('SERVICE_UNAVAILABLE', error.retryAfterSeconds);
};

const context = (request: OwnerRequest, rawBoardId: string, rawRevisionId: unknown) => {
  const boardId = BoardIdParserV1.parse(rawBoardId);
  const revisionId = GlobalIdStringParserV1.parse(rawRevisionId);
  if (!boardId.ok || !revisionId.ok) throw new ShareContractError('INVALID_REQUEST');
  if (request.boardPrincipal?.kind !== 'user' || request.authSession === undefined)
    throw new AppError('UNAUTHENTICATED');
  return {
    principal: request.boardPrincipal,
    boardId: boardId.data.value,
    revisionId: revisionId.data.value as RevisionId,
  };
};

const revisionQuery = (query: unknown): unknown =>
  query !== null && typeof query === 'object' && !Array.isArray(query)
    ? (query as Record<string, unknown>).revisionId
    : undefined;

const write = async (response: StreamResponse, bytes: Uint8Array): Promise<void> => {
  if (response.write(bytes)) return;
  await new Promise<void>((resolve, reject) => {
    const onDrain = (): void => {
      clearTimeout(timeout);
      resolve();
    };
    const timeout = setTimeout(() => {
      response.off('drain', onDrain);
      reject(new ShareContractError('SERVICE_UNAVAILABLE', 1));
    }, 5_000);
    timeout.unref();
    response.once('drain', onDrain);
  });
};

@Controller('api/v1/boards/:boardId/presentation-sessions')
@RequireBoardPrincipal()
export class OwnerPresentationSessionController {
  constructor(
    @Inject(OwnerPresentationSessionService)
    private readonly ownerSessions: OwnerPresentationSessionService,
    @Inject(PublicPresentationSessionService)
    private readonly sessions: PublicPresentationSessionService,
    @Inject(RedisService) private readonly redis: RedisService,
  ) {}

  @Get()
  @BoardOperationRateLimited('board-read')
  async list(
    @Req() request: OwnerRequest,
    @Param('boardId') boardId: string,
    @Query() query: unknown,
  ) {
    try {
      return await this.ownerSessions.list(context(request, boardId, revisionQuery(query)));
    } catch (error) {
      return contract(error);
    }
  }

  @Post()
  @RequireCsrf('session')
  @BoardOperationRateLimited('board-mutation')
  async start(
    @Req() request: OwnerRequest,
    @Param('boardId') boardId: string,
    @Query() query: unknown,
    @Body() body: unknown,
  ) {
    const parsed = PublicPresentationStartRequestParserV1.parse(body);
    if (!parsed.ok) throw new ShareContractError('INVALID_REQUEST');
    try {
      return await this.ownerSessions.start({
        ...context(request, boardId, revisionQuery(query)),
        currentPageId: parsed.data.value.currentPageId,
      });
    } catch (error) {
      return contract(error);
    }
  }

  @Get(':sessionId')
  @BoardOperationRateLimited('board-read')
  async get(
    @Req() request: OwnerRequest,
    @Param('boardId') boardId: string,
    @Param('sessionId') sessionId: string,
    @Query() query: unknown,
  ) {
    try {
      return await this.ownerSessions.get({
        ...context(request, boardId, revisionQuery(query)),
        sessionId,
      });
    } catch (error) {
      return contract(error);
    }
  }

  @Post(':sessionId/state')
  @RequireCsrf('session')
  @BoardOperationRateLimited('board-mutation')
  async update(
    @Req() request: OwnerRequest,
    @Param('boardId') boardId: string,
    @Param('sessionId') sessionId: string,
    @Query() query: unknown,
    @Body() body: unknown,
  ) {
    const parsed = PublicPresentationUpdateRequestParserV1.parse(body);
    if (!parsed.ok) throw new ShareContractError('INVALID_REQUEST');
    try {
      return await this.ownerSessions.update({
        ...context(request, boardId, revisionQuery(query)),
        sessionId,
        update: parsed.data.value,
      });
    } catch (error) {
      return contract(error);
    }
  }

  @Post(':sessionId/end')
  @RequireCsrf('session')
  @BoardOperationRateLimited('board-mutation')
  async end(
    @Req() request: OwnerRequest,
    @Param('boardId') boardId: string,
    @Param('sessionId') sessionId: string,
    @Query() query: unknown,
    @Body() body: unknown,
  ) {
    if (
      body === null ||
      typeof body !== 'object' ||
      Array.isArray(body) ||
      Object.keys(body as Record<string, unknown>).length !== 0
    )
      throw new ShareContractError('INVALID_REQUEST');
    try {
      return await this.ownerSessions.end({
        ...context(request, boardId, revisionQuery(query)),
        sessionId,
      });
    } catch (error) {
      return contract(error);
    }
  }

  @Get(':sessionId/events')
  @BoardOperationRateLimited('board-read')
  async events(
    @Req() request: OwnerRequest,
    @Res() response: StreamResponse,
    @Param('boardId') boardId: string,
    @Param('sessionId') sessionId: string,
    @Query() query: unknown,
  ): Promise<void> {
    let authorized;
    try {
      authorized = await this.ownerSessions.authorize(
        context(request, boardId, revisionQuery(query)),
      );
    } catch (error) {
      return contract(error);
    }
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
            await write(
              response,
              Buffer.from(
                `event: presentation.state.v1\nid: ${current.version}\ndata: ${JSON.stringify({
                  type: 'presentation.state.v1',
                  snapshot: current,
                })}\n\n`,
                'utf8',
              ),
            );
            lastVersion = current.version;
          }
          dirty = false;
        }
        if (Date.now() - lastKeepaliveAt >= 10_000) {
          await write(response, Buffer.from(': sceneboard-presentation-keepalive\n\n', 'ascii'));
          lastKeepaliveAt = Date.now();
        }
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 1_000);
          timer.unref();
          wake = () => {
            clearTimeout(timer);
            wake = null;
            resolve();
          };
          if (dirty) wake();
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
}
