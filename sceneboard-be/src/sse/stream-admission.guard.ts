import { CanActivate, ExecutionContext, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { BoardIdParserV1, type BoardId, type TabId } from '@sceneboard/board-schema';

import { BoardContractError } from '../common/errors/app-error.js';
import { invalidBoardPayload } from '../common/errors/board-error.factory.js';

const BROWSER_BOARD_STREAM = Symbol('BROWSER_BOARD_STREAM');
const TAB_ID = /^[A-Za-z0-9_-]{22}$/u;
const VISIBLE_CURSOR = /^[\x21-\x7e]{1,512}$/u;

export type BrowserBoardStreamAdmissionV1 = {
  boardId: BoardId;
  tabId: TabId;
  presenceState: 'online' | 'away';
  cursor: string | null;
  documentSchemaVersion: 1 | 2;
};

export interface BrowserBoardStreamRequestV1 {
  method: string;
  headers: Record<string, string | string[] | undefined>;
  params?: Record<string, unknown> | undefined;
  query?: Record<string, unknown> | undefined;
  boardStreamAdmission?: BrowserBoardStreamAdmissionV1 | undefined;
}

export const RequireBrowserBoardStream = (): MethodDecorator =>
  SetMetadata(BROWSER_BOARD_STREAM, true);

const invalid = (issue: string, path: Array<string | number> = []): BoardContractError => {
  const error = invalidBoardPayload(issue);
  error.details = { path, issue };
  return new BoardContractError(error);
};

const scalarHeader = (
  headers: BrowserBoardStreamRequestV1['headers'],
  name: string,
): string | undefined => {
  const value = headers[name];
  if (Array.isArray(value)) throw invalid(`${name} must be a singleton header`);
  return value;
};

const includesEventStream = (accept: string): boolean =>
  accept
    .split(',')
    .some((part) => part.trim().split(';', 1)[0]?.trim().toLowerCase() === 'text/event-stream');

@Injectable()
export class StreamAdmissionGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<boolean | undefined>(BROWSER_BOARD_STREAM, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (required !== true) return true;
    const request = context.switchToHttp().getRequest<BrowserBoardStreamRequestV1>();
    if (request.method !== 'GET') throw invalid('board stream method must be GET');
    const accept = scalarHeader(request.headers, 'accept');
    if (accept === undefined || !includesEventStream(accept))
      throw invalid('Accept must include text/event-stream');
    if (request.headers.authorization !== undefined)
      throw invalid('Authorization is forbidden for browser streams');
    const contentLength = scalarHeader(request.headers, 'content-length');
    if (contentLength !== undefined && contentLength !== '0')
      throw invalid('board stream body is forbidden');
    if (request.headers['transfer-encoding'] !== undefined)
      throw invalid('board stream transfer body is forbidden');

    const board = BoardIdParserV1.parse(request.params?.boardId);
    if (!board.ok) throw invalid('invalid boardId', ['boardId']);
    const query = request.query ?? (Object.create(null) as Record<string, unknown>);
    const keys = Object.keys(query).sort();
    const v1Keys = 'presenceState,tabId';
    const v2Keys = 'documentSchemaVersion,presenceState,tabId';
    if (keys.join(',') !== v1Keys && keys.join(',') !== v2Keys)
      throw invalid(
        'query must contain tabId and presenceState with at most one documentSchemaVersion',
      );
    if (typeof query.tabId !== 'string' || !TAB_ID.test(query.tabId))
      throw invalid('invalid tabId', ['tabId']);
    if (query.presenceState !== 'online' && query.presenceState !== 'away') {
      throw invalid('invalid presenceState', ['presenceState']);
    }
    if (Object.hasOwn(query, 'documentSchemaVersion') && query.documentSchemaVersion !== '2')
      throw invalid('documentSchemaVersion must be exactly 2', ['documentSchemaVersion']);
    const cursorValue = request.headers['last-event-id'];
    if (
      Array.isArray(cursorValue) ||
      (cursorValue !== undefined && !VISIBLE_CURSOR.test(cursorValue))
    ) {
      throw invalid('invalid Last-Event-ID');
    }
    request.boardStreamAdmission = {
      boardId: board.data.value,
      tabId: query.tabId as TabId,
      presenceState: query.presenceState,
      cursor: cursorValue ?? null,
      documentSchemaVersion: query.documentSchemaVersion === '2' ? 2 : 1,
    };
    return true;
  }
}
