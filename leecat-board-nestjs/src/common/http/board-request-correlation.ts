import {
  GlobalIdStringParserV1,
  type RequestId,
} from '@leecat-board/board-schema';

import { BoardContractError } from '../errors/app-error.js';
import { BoardPersistenceError } from '../errors/board-persistence.error.js';

export const BOARD_REQUEST_ID = Symbol('BOARD_REQUEST_ID');

export interface BoardRequestCorrelationCarrier {
  [BOARD_REQUEST_ID]?: RequestId;
}

export const admitBoardRequestId = (
  request: BoardRequestCorrelationCarrier,
  value: unknown,
): RequestId => {
  const parsed = GlobalIdStringParserV1.parse(value);
  if (!parsed.ok) throw new BoardContractError(parsed.error);
  const requestId = parsed.data.value as RequestId;
  if (request[BOARD_REQUEST_ID] !== undefined && request[BOARD_REQUEST_ID] !== requestId) {
    throw new BoardPersistenceError('row_integrity');
  }
  request[BOARD_REQUEST_ID] = requestId;
  return requestId;
};

export const admittedBoardRequestId = (
  request: BoardRequestCorrelationCarrier,
): RequestId | null => request[BOARD_REQUEST_ID] ?? null;

export const boardRequestIdFromUrl = (value: string | undefined): RequestId | null => {
  if (value === undefined) return null;
  let candidates: string[];
  try {
    candidates = new URL(value, 'http://sceneboard.internal').searchParams.getAll('requestId');
  } catch {
    return null;
  }
  if (candidates.length !== 1) return null;
  const parsed = GlobalIdStringParserV1.parse(candidates[0]);
  return parsed.ok ? parsed.data.value as RequestId : null;
};
