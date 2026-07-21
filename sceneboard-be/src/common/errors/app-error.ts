import type { BoardErrorV1 } from '@sceneboard/board-schema';

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
  readonly boardError: BoardErrorV1;
  readonly status: number;

  constructor(boardError: BoardErrorV1) {
    super(boardError.message);
    this.name = 'BoardContractError';
    this.boardError = boardError;
    this.status = boardError.httpStatusHint;
  }
}

export type BoardHttpErrorResponseV1 = { error: BoardErrorV1 };
export type D2HttpErrorResponse = { error: D2ErrorPayload };
