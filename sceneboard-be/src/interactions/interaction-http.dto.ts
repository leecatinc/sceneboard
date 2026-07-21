import {
  BoardOperationRequestParserV1,
  MutationRequestParserV1,
  type BoardId,
  type HitlRequestId,
} from '@sceneboard/board-schema';

import { BoardContractError } from '../common/errors/app-error.js';
import { invalidBoardPayload } from '../common/errors/board-error.factory.js';
import {
  type HitlCancelAdapterRequestV1,
  type HitlSupersedeAdapterRequestV1,
} from './application/hitl-lifecycle-application.port.js';
import type { HitlReadOperationRequestV1 } from './application/hitl-query-application.port.js';

const invalid = (issue: string, path: Array<string | number> = []): BoardContractError => {
  const error = invalidBoardPayload(issue);
  error.details = { path, issue };
  return new BoardContractError(error);
};

const record = (value: unknown, allowed: readonly string[]): Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw invalid('invalid body');
  const source = value as Record<string, unknown>;
  if (Object.keys(source).some((key) => !allowed.includes(key)))
    throw invalid('unknown body field');
  return source;
};

const queryRecord = (value: unknown, allowed: readonly string[]): Record<string, string> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw invalid('invalid query');
  const source = value as Record<string, unknown>;
  const result: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const key of Object.keys(source)) {
    if (!allowed.includes(key)) throw invalid('unknown or repeated query field', [key]);
    const item = source[key];
    if (typeof item !== 'string' || item.length === 0) {
      throw invalid('query fields must be non-empty scalars', [key]);
    }
    result[key] = item;
  }
  return result;
};

export const parseHitlReadQuery = (input: {
  query: unknown;
  requestId: string;
  boardId: string;
  hitlRequestId: string;
}): HitlReadOperationRequestV1 => {
  const query = queryRecord(input.query, ['requestId', 'afterStateUpdatedAt', 'timeoutMs']);
  const hasCursor = query.afterStateUpdatedAt !== undefined;
  const hasTimeout = query.timeoutMs !== undefined;
  if (hasCursor !== hasTimeout) throw invalid('wait query keys must be provided together');
  if (query.requestId !== undefined && query.requestId !== input.requestId) {
    throw invalid('request ID mismatch', ['requestId']);
  }
  const timeoutMs =
    hasTimeout && /^[0-9]{1,5}$/u.test(query.timeoutMs as string) ? Number(query.timeoutMs) : null;
  if (hasTimeout && (timeoutMs === null || timeoutMs > 30_000)) {
    throw invalid('timeoutMs must be between 0 and 30000', ['timeoutMs']);
  }
  const parsed = BoardOperationRequestParserV1.parse({
    protocolVersion: 1,
    requestId: input.requestId,
    type: 'hitl.read',
    boardId: input.boardId,
    hitlRequestId: input.hitlRequestId,
    wait: hasCursor
      ? {
          afterStateUpdatedAt: query.afterStateUpdatedAt,
          timeoutMs,
        }
      : null,
  });
  if (!parsed.ok || parsed.data.value.type !== 'hitl.read') {
    throw new BoardContractError(
      parsed.ok ? invalidBoardPayload('invalid hitl.read query') : parsed.error,
    );
  }
  return parsed.data.value as HitlReadOperationRequestV1;
};

export const parseHitlLifecycleBody = (input: {
  body: unknown;
  requestId: string;
  boardId: BoardId;
  hitlRequestId: HitlRequestId;
  action: 'cancel' | 'supersede';
}): HitlCancelAdapterRequestV1 | HitlSupersedeAdapterRequestV1 => {
  const allowed =
    input.action === 'cancel'
      ? ['protocolVersion', 'requestId', 'expectedRevisionId', 'expectedStateUpdatedAt']
      : [
          'protocolVersion',
          'requestId',
          'expectedRevisionId',
          'expectedStateUpdatedAt',
          'successorHitlRequestId',
        ];
  const value = record(input.body, allowed);
  if (value.protocolVersion !== 1 || value.requestId !== input.requestId) {
    throw invalid('invalid lifecycle request identity');
  }
  const mutation = MutationRequestParserV1.parse({
    protocolVersion: 1,
    requestId: input.requestId,
    idempotencyKey: 'hitl-lifecycle-v1',
    boardId: input.boardId,
    expectedRevisionId: value.expectedRevisionId,
    command: { type: 'scene.clear' },
  });
  const cursor = BoardOperationRequestParserV1.parse({
    protocolVersion: 1,
    requestId: input.requestId,
    type: 'hitl.read',
    boardId: input.boardId,
    hitlRequestId: input.hitlRequestId,
    wait: { afterStateUpdatedAt: value.expectedStateUpdatedAt, timeoutMs: 0 },
  });
  if (!mutation.ok) throw new BoardContractError(mutation.error);
  if (!cursor.ok || cursor.data.value.type !== 'hitl.read' || cursor.data.value.wait === null) {
    throw new BoardContractError(
      cursor.ok ? invalidBoardPayload('invalid lifecycle cursor') : cursor.error,
    );
  }
  const base: HitlCancelAdapterRequestV1 = {
    protocolVersion: 1,
    requestId: mutation.data.value.requestId,
    expectedRevisionId: mutation.data.value.expectedRevisionId,
    expectedStateUpdatedAt: cursor.data.value.wait.afterStateUpdatedAt,
  };
  if (input.action === 'cancel') return base;
  const successor = BoardOperationRequestParserV1.parse({
    protocolVersion: 1,
    requestId: input.requestId,
    type: 'hitl.read',
    boardId: input.boardId,
    hitlRequestId: value.successorHitlRequestId,
    wait: null,
  });
  if (!successor.ok || successor.data.value.type !== 'hitl.read') {
    throw new BoardContractError(
      successor.ok ? invalidBoardPayload('invalid successor') : successor.error,
    );
  }
  return { ...base, successorHitlRequestId: successor.data.value.hitlRequestId };
};
