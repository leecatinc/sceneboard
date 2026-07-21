import type { BoardErrorV1 } from '@sceneboard/board-schema';

import type { BoardSdkHttpLocalErrorV1 } from '../http/index.js';

export type SafeBoardUiErrorV1 = {
  kind:
    | 'unauthenticated'
    | 'forbidden'
    | 'not_found'
    | 'rate_limited'
    | 'offline'
    | 'corrupt'
    | 'unavailable'
    | 'unknown';
  message: string;
  retryable: boolean;
};

export const toSafeBoardUiErrorV1 = (
  error: BoardErrorV1 | BoardSdkHttpLocalErrorV1,
): SafeBoardUiErrorV1 => {
  if (error.code === 'UNAUTHENTICATED')
    return {
      kind: 'unauthenticated',
      message: 'Your session needs to be verified again.',
      retryable: false,
    };
  if (error.code === 'FORBIDDEN' || error.code === 'CAPABILITY_DENIED')
    return {
      kind: 'forbidden',
      message: 'This board is not available to this account.',
      retryable: false,
    };
  if (error.code === 'BOARD_NOT_FOUND' || error.code === 'REVISION_NOT_FOUND')
    return {
      kind: 'not_found',
      message: 'The requested board view was not found.',
      retryable: false,
    };
  if (error.code === 'RATE_LIMITED')
    return {
      kind: 'rate_limited',
      message: 'SceneBoard is receiving too many requests. Try again shortly.',
      retryable: true,
    };
  if (error.code === 'SERVICE_UNAVAILABLE')
    return {
      kind: 'unavailable',
      message: 'SceneBoard is temporarily unavailable.',
      retryable: true,
    };
  if (error.code === 'TRANSPORT_ERROR' || error.code === 'TIMEOUT')
    return {
      kind: 'offline',
      message: 'The latest board view could not be reached.',
      retryable: true,
    };
  if (error.code === 'RESPONSE_INVALID')
    return {
      kind: 'corrupt',
      message: 'The board response could not be verified.',
      retryable: false,
    };
  if (error.code === 'CANCELLED')
    return { kind: 'unknown', message: 'The request was cancelled.', retryable: false };
  return {
    kind: 'unknown',
    message: 'SceneBoard could not complete this request.',
    retryable: error.retryable,
  };
};
