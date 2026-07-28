import { All, Controller, Get, Inject, Param, Post, Query, Req, Res } from '@nestjs/common';
import {
  BoardIdParserV1,
  ShareAnalyticsContextRequestSchemaV1,
  ShareAnalyticsEventSchemaV1,
} from '@sceneboard/board-schema';

import type { BoardPrincipalRequest } from '../common/guards/board-principal.guard.js';
import { RequireBoardPrincipal } from '../common/guards/board-principal.guard.js';
import { ShareAnalyticsError } from '../common/errors/share-analytics.error.js';
import { D2RateLimited } from '../rate-limit/d2-rate-limit.guards.js';
import { isSuppressedShareView } from './context/share-view-classifier.js';
import { ShareAnalyticsContextService } from './context/share-analytics-context.service.js';
import { ShareAnalyticsEventService } from './event/share-analytics-event.service.js';
import { ShareAnalyticsReportService } from './report/share-analytics-report.service.js';

interface AnalyticsRequest extends BoardPrincipalRequest {
  body?: unknown;
  headers: Record<string, string | string[] | undefined>;
}

interface AnalyticsResponse {
  setHeader(name: string, value: string | readonly string[]): unknown;
  status(code: number): AnalyticsResponse;
  json(value: unknown): unknown;
}

const one = (value: string | string[] | undefined): string | undefined =>
  typeof value === 'string' ? value : undefined;

const assertOrigin = (request: AnalyticsRequest, browserOrigin: string): void => {
  if (one(request.headers.origin) !== browserOrigin) throw new ShareAnalyticsError('CSRF_INVALID');
};

const parseRange = (query: unknown): { from: string; to: string } => {
  if (query === null || typeof query !== 'object' || Array.isArray(query))
    throw new ShareAnalyticsError('INVALID_PAYLOAD');
  const record = query as Record<string, unknown>;
  if (
    Object.keys(record).length !== 2 ||
    typeof record.from !== 'string' ||
    typeof record.to !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/u.test(record.from) ||
    !/^\d{4}-\d{2}-\d{2}$/u.test(record.to)
  )
    throw new ShareAnalyticsError('INVALID_PAYLOAD');
  const from = new Date(`${record.from}T00:00:00.000Z`);
  const to = new Date(`${record.to}T00:00:00.000Z`);
  if (
    !Number.isFinite(from.valueOf()) ||
    !Number.isFinite(to.valueOf()) ||
    from.toISOString().slice(0, 10) !== record.from ||
    to.toISOString().slice(0, 10) !== record.to ||
    from > to ||
    to.valueOf() - from.valueOf() > 397 * 24 * 60 * 60 * 1_000
  )
    throw new ShareAnalyticsError('INVALID_PAYLOAD');
  return { from: record.from, to: record.to };
};

@Controller('api/v1')
export class ShareAnalyticsController {
  constructor(
    @Inject(ShareAnalyticsContextService)
    private readonly contexts: ShareAnalyticsContextService,
    @Inject(ShareAnalyticsEventService)
    private readonly events: ShareAnalyticsEventService,
    @Inject(ShareAnalyticsReportService)
    private readonly reports: ShareAnalyticsReportService,
    @Inject('SHARE_ANALYTICS_BROWSER_ORIGIN')
    private readonly browserOrigin: string,
  ) {}

  @Post('public/shares/:shareId/view-contexts')
  @D2RateLimited('share-analytics-context')
  async createContext(
    @Req() request: AnalyticsRequest,
    @Res() response: AnalyticsResponse,
    @Param('shareId') shareId: string,
  ): Promise<void> {
    assertOrigin(request, this.browserOrigin);
    if (!ShareAnalyticsContextRequestSchemaV1.safeParse(request.body).success)
      throw new ShareAnalyticsError('INVALID_PAYLOAD');
    if (
      isSuppressedShareView({
        userAgent: one(request.headers['user-agent']),
        purpose: one(request.headers.purpose),
        secPurpose: one(request.headers['sec-purpose']),
      })
    )
      throw new ShareAnalyticsError('SHARE_VIEW_UNAVAILABLE');
    const result = await this.contexts.issue({
      shareId,
      cookieHeader: one(request.headers.cookie),
    });
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Set-Cookie', result.setCookies);
    response.status(201).json(result.context);
  }

  @Post('public/share-view-events')
  @D2RateLimited('share-analytics-event')
  async createEvent(
    @Req() request: AnalyticsRequest,
    @Res() response: AnalyticsResponse,
  ): Promise<void> {
    assertOrigin(request, this.browserOrigin);
    const parsed = ShareAnalyticsEventSchemaV1.safeParse(request.body);
    if (!parsed.success) throw new ShareAnalyticsError('INVALID_PAYLOAD');
    const result = await this.events.admit({
      event: parsed.data,
      cookieHeader: one(request.headers.cookie),
      csrfHeader: one(request.headers['x-sceneboard-view-csrf']),
    });
    response.setHeader('Cache-Control', 'no-store');
    response.status(result.statusCode).json(result.result);
  }

  @Get('boards/:boardId/share-analytics')
  @RequireBoardPrincipal()
  async report(
    @Req() request: AnalyticsRequest,
    @Res() response: AnalyticsResponse,
    @Param('boardId') boardIdSource: string,
    @Query() query: unknown,
  ): Promise<void> {
    const boardId = BoardIdParserV1.parse(boardIdSource);
    if (!boardId.ok) throw new ShareAnalyticsError('BOARD_NOT_FOUND');
    const principal = request.boardPrincipal;
    if (principal === undefined) throw new ShareAnalyticsError('UNAUTHENTICATED');
    if (principal.kind !== 'user') throw new ShareAnalyticsError('BOARD_NOT_FOUND');
    const range = parseRange(query);
    const report = await this.reports.read({
      boardId: boardId.data.value,
      ownerUserPk: principal.userPk,
      ...range,
    });
    response.setHeader('Cache-Control', 'private, no-store');
    response.status(200).json(report);
  }

  @All('public/shares/:shareId/view-contexts')
  unsupportedContext(): never {
    throw new ShareAnalyticsError('INVALID_PAYLOAD');
  }

  @All('public/share-view-events')
  unsupportedEvent(): never {
    throw new ShareAnalyticsError('INVALID_PAYLOAD');
  }
}
