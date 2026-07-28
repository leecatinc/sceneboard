import type { BoardError } from '@sceneboard/board-schema';

export type MediaRequestReason =
  | 'request_id'
  | 'framing'
  | 'content_type'
  | 'length'
  | 'digest'
  | 'idempotency_key';

export type MediaUploadReason =
  | 'format'
  | 'dimensions'
  | 'pixels'
  | 'ratio'
  | 'animated'
  | 'canonical_size'
  | 'decode'
  | 'quota';

export const invalidMediaRequest = (reason: MediaRequestReason): BoardError => ({
  protocolVersion: 1,
  type: 'board.error',
  code: 'INVALID_REQUEST',
  message: 'Invalid request',
  category: 'validation',
  retryable: false,
  httpStatusHint: 400,
  details: { reason },
});

export const mediaBoardNotFound = (): BoardError => ({
  protocolVersion: 1,
  type: 'board.error',
  code: 'BOARD_NOT_FOUND',
  message: 'Board not found',
  category: 'not_found',
  retryable: false,
  httpStatusHint: 404,
  details: null,
});

export const mediaPayloadTooLarge = (): BoardError => ({
  protocolVersion: 1,
  type: 'board.error',
  code: 'PAYLOAD_TOO_LARGE',
  message: 'Payload is too large',
  category: 'validation',
  retryable: false,
  httpStatusHint: 413,
  details: { limitBytes: 10_485_760 },
});

export const invalidMediaUpload = (reason: MediaUploadReason): BoardError => ({
  protocolVersion: 1,
  type: 'board.error',
  code: 'INVALID_MEDIA_UPLOAD',
  message: 'Invalid media upload',
  category: 'validation',
  retryable: false,
  httpStatusHint: 422,
  details: { reason },
});

export const mediaIdempotencyConflict = (): BoardError => ({
  protocolVersion: 1,
  type: 'board.error',
  code: 'IDEMPOTENCY_KEY_REUSED',
  message: 'Idempotency key reused',
  category: 'conflict',
  retryable: false,
  httpStatusHint: 409,
  details: { scope: 'media.ingest' },
});

export const mediaIdempotencyExpired = (): BoardError => ({
  protocolVersion: 1,
  type: 'board.error',
  code: 'IDEMPOTENCY_RESULT_EXPIRED',
  message: 'Idempotency result expired',
  category: 'conflict',
  retryable: false,
  httpStatusHint: 409,
  details: { scope: 'media.ingest' },
});

export const mediaServiceUnavailable = (): BoardError => ({
  protocolVersion: 1,
  type: 'board.error',
  code: 'SERVICE_UNAVAILABLE',
  message: 'Service unavailable',
  category: 'availability',
  retryable: true,
  httpStatusHint: 503,
  details: { retryAfterSeconds: 1 },
});

export const mediaRangeNotSatisfiable = (length: number): BoardError => ({
  protocolVersion: 1,
  type: 'board.error',
  code: 'RANGE_NOT_SATISFIABLE',
  message: 'Range not satisfiable',
  category: 'validation',
  retryable: false,
  httpStatusHint: 416,
  details: { length },
});

export const mediaMethodNotAllowed = (): BoardError => ({
  protocolVersion: 1,
  type: 'board.error',
  code: 'METHOD_NOT_ALLOWED',
  message: 'Method not allowed',
  category: 'validation',
  retryable: false,
  httpStatusHint: 405,
  details: { allow: 'GET' },
});

export const mediaRateLimited = (): BoardError => ({
  protocolVersion: 1,
  type: 'board.error',
  code: 'RATE_LIMITED',
  message: 'Rate limited',
  category: 'rate_limit',
  retryable: true,
  httpStatusHint: 429,
  details: { retryAfterSeconds: 1 },
});
