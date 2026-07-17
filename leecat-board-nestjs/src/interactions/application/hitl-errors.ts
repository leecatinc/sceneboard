import type { HitlInteractionV1, HitlRequestId, TimestampV1 } from '@leecat-board/board-schema';

import { BoardContractError } from '../../common/errors/app-error.js';

const error = (input: ConstructorParameters<typeof BoardContractError>[0]): BoardContractError => (
  new BoardContractError(input)
);

export const hitlNotFound = (hitlRequestId: HitlRequestId): BoardContractError => error({
  protocolVersion: 1,
  type: 'board.error',
  code: 'HITL_REQUEST_NOT_FOUND',
  message: 'HITL request not found',
  category: 'not_found',
  retryable: false,
  httpStatusHint: 404,
  details: { hitlRequestId },
});

export const hitlIdConflict = (hitlRequestId: HitlRequestId): BoardContractError => error({
  protocolVersion: 1,
  type: 'board.error',
  code: 'HITL_REQUEST_ID_CONFLICT',
  message: 'HITL request ID conflict',
  category: 'conflict',
  retryable: false,
  httpStatusHint: 409,
  details: { hitlRequestId },
});

export const hitlResponseConflict = (
  hitlRequestId: HitlRequestId,
  state: Extract<HitlInteractionV1['state'], 'answered' | 'superseded' | 'cancelled'>,
): BoardContractError => error({
  protocolVersion: 1,
  type: 'board.error',
  code: 'HITL_RESPONSE_CONFLICT',
  message: 'HITL response conflict',
  category: 'conflict',
  retryable: false,
  httpStatusHint: 409,
  details: { hitlRequestId, state },
});

export const hitlExpired = (
  hitlRequestId: HitlRequestId,
  expiredAt: TimestampV1,
): BoardContractError => error({
  protocolVersion: 1,
  type: 'board.error',
  code: 'HITL_REQUEST_EXPIRED',
  message: 'HITL request expired',
  category: 'conflict',
  retryable: false,
  httpStatusHint: 410,
  details: { hitlRequestId, expiredAt },
});

export const invalidHitlResponse = (): BoardContractError => error({
  protocolVersion: 1,
  type: 'board.error',
  code: 'INVALID_PAYLOAD',
  message: 'Invalid HITL response',
  category: 'validation',
  retryable: false,
  httpStatusHint: 400,
  details: { path: ['command', 'response'], issue: 'response does not match the stored request' },
});

export const forbiddenHitlResponse = (): BoardContractError => error({
  protocolVersion: 1,
  type: 'board.error',
  code: 'FORBIDDEN',
  message: 'Forbidden',
  category: 'auth',
  retryable: false,
  httpStatusHint: 403,
  details: null,
});

export const invalidHitlLifecycleCursor = (): BoardContractError => error({
  protocolVersion: 1,
  type: 'board.error',
  code: 'INVALID_PAYLOAD',
  message: 'Invalid HITL lifecycle cursor',
  category: 'validation',
  retryable: false,
  httpStatusHint: 400,
  details: {
    path: ['expectedStateUpdatedAt'],
    issue: 'cursor does not match the current open interaction',
  },
});

export const internalHitlFailure = (): BoardContractError => error({
  protocolVersion: 1,
  type: 'board.error',
  code: 'INTERNAL_ERROR',
  message: 'Internal error',
  category: 'internal',
  retryable: false,
  httpStatusHint: 500,
  details: null,
});
