import type { BoardError, BoardErrorV1 } from '@sceneboard/board-schema';
import type { ShareErrorCodeV1 } from '@sceneboard/board-schema';

export const D2_ERROR_CATALOG = {
  INVALID_PAYLOAD: { status: 400, message: 'Invalid payload' },
  AUTH_PASSWORD_POLICY: { status: 422, message: 'Password does not meet the security policy' },
  AUTH_CURRENT_PASSWORD_INVALID: { status: 400, message: 'Current password is invalid' },
  AUTH_PASSWORD_UNCHANGED: {
    status: 409,
    message: 'New password must differ from the current password',
  },
  AUTH_EMAIL_IN_USE: { status: 409, message: 'Email is already in use' },
  AUTH_EMAIL_VERIFICATION_INVALID: {
    status: 400,
    message: 'Email verification code is invalid or expired',
  },
  AUTH_EMAIL_VERIFICATION_REQUIRED: { status: 403, message: 'Email verification is required' },
  AUTH_INVALID_CREDENTIALS: { status: 401, message: 'Invalid email or password' },
  UNAUTHENTICATED: { status: 401, message: 'Authentication is required' },
  AUTH_SESSION_PRESENT: { status: 409, message: 'An authenticated session is already present' },
  AUTH_SESSION_EXPIRED: { status: 401, message: 'The session has expired' },
  AUTH_SESSION_REVOKED: { status: 401, message: 'The session is no longer active' },
  AUTH_SESSION_REUSED: { status: 401, message: 'Session credential reuse was detected' },
  CSRF_INVALID: { status: 403, message: 'Request verification failed' },
  PAIRING_UNAVAILABLE: { status: 400, message: 'Pairing is unavailable' },
  PAIRING_NOT_FOUND: { status: 404, message: 'Pairing was not found' },
  PAIRING_STATE_CONFLICT: { status: 409, message: 'Pairing state does not allow this operation' },
  PAIRING_SCOPE_INVALID: { status: 422, message: 'Pairing approval is invalid' },
  PAIRING_PROOF_INVALID: { status: 401, message: 'Pairing proof is invalid' },
  PAIRING_NOT_READY: { status: 409, message: 'Pairing is not ready' },
  PAIRING_TERMINAL: { status: 410, message: 'Pairing has reached a terminal state' },
  GRANT_NOT_FOUND: { status: 404, message: 'Grant was not found' },
  GRANT_NOT_ACTIVE: { status: 409, message: 'Grant is not active' },
  INVITATION_NOT_FOUND: { status: 404, message: 'Invitation was not found' },
  INVITATION_CONFLICT: { status: 409, message: 'Invitation state does not allow this operation' },
  INVITATION_GONE: { status: 410, message: 'Invitation is no longer active' },
  MEMBERSHIP_CONFLICT: { status: 409, message: 'Membership state does not allow this operation' },
  RATE_LIMITED: { status: 429, message: 'Too many requests' },
  SERVICE_UNAVAILABLE: { status: 503, message: 'Service is temporarily unavailable' },
  INTERNAL_ERROR: { status: 500, message: 'Internal server error' },
} as const;

export type D2ErrorCode = keyof typeof D2_ERROR_CATALOG;

export interface D2ErrorPayload {
  code: D2ErrorCode;
  message: string;
}

export class AppError extends Error {
  readonly code: D2ErrorCode;
  readonly status: number;
  readonly retryAfterSeconds: number | null;

  constructor(
    code: D2ErrorCode,
    options: { retryAfterSeconds?: number | null; cause?: unknown } = {},
  ) {
    const definition = D2_ERROR_CATALOG[code];
    super(definition.message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'AppError';
    this.code = code;
    this.status = definition.status;
    this.retryAfterSeconds = options.retryAfterSeconds ?? null;
  }

  toPayload(): D2ErrorPayload {
    return { code: this.code, message: this.message };
  }
}

export class BoardContractError extends Error {
  readonly boardError: BoardError;
  readonly status: number;

  constructor(boardError: BoardError) {
    super(boardError.message);
    this.name = 'BoardContractError';
    this.boardError = boardError;
    this.status = boardError.httpStatusHint;
  }
}

const SHARE_ERROR_STATUS: Readonly<Record<ShareErrorCodeV1, number>> = {
  INVALID_REQUEST: 400,
  UNAUTHENTICATED: 401,
  BOARD_NOT_FOUND: 404,
  SHARE_STATE_CONFLICT: 409,
  SHARE_GENERATION_EXHAUSTED: 409,
  IDEMPOTENCY_KEY_REUSED: 409,
  SHARE_PASSWORD_ALREADY_ENABLED: 409,
  SHARE_PASSWORD_STATE_CONFLICT: 409,
  SHARE_PASSWORD_LOCKED: 429,
  RATE_LIMITED: 429,
  SERVICE_UNAVAILABLE: 503,
};

const SHARE_ERROR_MESSAGE: Readonly<Record<ShareErrorCodeV1, string>> = {
  INVALID_REQUEST: 'Invalid request.',
  UNAUTHENTICATED: 'Authentication required.',
  BOARD_NOT_FOUND: 'Board not found.',
  SHARE_STATE_CONFLICT: 'Share state conflict.',
  SHARE_GENERATION_EXHAUSTED: 'Share generation exhausted.',
  IDEMPOTENCY_KEY_REUSED: 'Idempotency key reused.',
  SHARE_PASSWORD_ALREADY_ENABLED: 'Share password is already enabled.',
  SHARE_PASSWORD_STATE_CONFLICT: 'Share password state conflict.',
  SHARE_PASSWORD_LOCKED: 'Share password is temporarily locked.',
  RATE_LIMITED: 'Too many requests.',
  SERVICE_UNAVAILABLE: 'Service unavailable.',
};

export class ShareContractError extends Error {
  readonly code: ShareErrorCodeV1;
  readonly status: number;
  readonly retryAfterSeconds: number | null;
  readonly reason: 'body' | 'csrf' | null;

  constructor(
    code: ShareErrorCodeV1,
    retryAfterSeconds: number | null = null,
    reason?: 'body' | 'csrf',
    cause?: unknown,
  ) {
    super(SHARE_ERROR_MESSAGE[code], cause === undefined ? undefined : { cause });
    this.name = 'ShareContractError';
    this.code = code;
    this.status = SHARE_ERROR_STATUS[code];
    this.retryAfterSeconds = retryAfterSeconds;
    this.reason = code === 'INVALID_REQUEST' ? (reason ?? 'body') : null;
  }
}

export type BoardHttpErrorResponseV1 = { error: BoardErrorV1 };
export type D2HttpErrorResponse = { error: D2ErrorPayload };
