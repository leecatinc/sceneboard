import { GlobalIdStringParserV1, type RequestId } from '@sceneboard/board-schema';

import { BoardContractError } from '../errors/app-error.js';
import { BoardPersistenceError } from '../errors/board-persistence.error.js';
import { invalidMediaRequest } from '../../media/media-errors.js';

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

export const admittedBoardRequestId = (request: BoardRequestCorrelationCarrier): RequestId | null =>
  request[BOARD_REQUEST_ID] ?? null;

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
  return parsed.ok ? (parsed.data.value as RequestId) : null;
};

export const admitSingletonBoardRequestIdQuery = (
  request: BoardRequestCorrelationCarrier,
  originalUrl: string | undefined,
): RequestId => {
  if (originalUrl === undefined || originalUrl.includes('#')) {
    throw new BoardContractError(invalidMediaRequest('request_id'));
  }
  const marker = originalUrl.indexOf('?');
  if (marker < 1 || originalUrl.indexOf('?', marker + 1) !== -1) {
    throw new BoardContractError(invalidMediaRequest('request_id'));
  }
  const query = originalUrl.slice(marker + 1);
  const parts = query.split('&');
  if (parts.length !== 1) throw new BoardContractError(invalidMediaRequest('request_id'));
  const separator = parts[0]!.indexOf('=');
  if (separator < 1 || parts[0]!.indexOf('=', separator + 1) !== -1) {
    throw new BoardContractError(invalidMediaRequest('request_id'));
  }
  const rawKey = parts[0]!.slice(0, separator);
  const rawValue = parts[0]!.slice(separator + 1);
  if (rawKey !== 'requestId' || rawValue.length === 0 || rawValue.includes('+')) {
    throw new BoardContractError(invalidMediaRequest('request_id'));
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawValue);
  } catch {
    throw new BoardContractError(invalidMediaRequest('request_id'));
  }
  try {
    return admitBoardRequestId(request, decoded);
  } catch {
    throw new BoardContractError(invalidMediaRequest('request_id'));
  }
};
