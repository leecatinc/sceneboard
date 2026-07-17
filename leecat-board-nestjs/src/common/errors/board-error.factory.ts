import type { BoardErrorV1 } from '@leecat-board/board-schema';

export const invalidBoardPayload = (issue: string): BoardErrorV1 => ({
  protocolVersion: 1,
  type: 'board.error',
  code: 'INVALID_PAYLOAD',
  message: 'Invalid payload',
  category: 'validation',
  retryable: false,
  httpStatusHint: 400,
  details: { path: [], issue: issue.slice(0, 200) || 'invalid payload' },
});

export const boardPayloadTooLarge = (actualBytes: number, maximumBytes: number): BoardErrorV1 => ({
  protocolVersion: 1,
  type: 'board.error',
  code: 'PAYLOAD_TOO_LARGE',
  message: 'Payload is too large',
  category: 'validation',
  retryable: false,
  httpStatusHint: 413,
  details: { scope: 'envelope', actualBytes, maximumBytes },
});
