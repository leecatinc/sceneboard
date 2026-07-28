import type { ShareAnalyticsErrorCodeV1 } from '@sceneboard/board-schema';

const DEFINITIONS = {
  INVALID_PAYLOAD: [400, 'Invalid payload'],
  UNAUTHENTICATED: [401, 'Authentication is required'],
  CSRF_INVALID: [403, 'CSRF validation failed'],
  SHARE_VIEW_UNAVAILABLE: [404, 'Share view unavailable'],
  BOARD_NOT_FOUND: [404, 'Board not found'],
  IDEMPOTENCY_KEY_REUSED: [409, 'Idempotency key reused'],
  RATE_LIMITED: [429, 'Rate limited'],
  SERVICE_UNAVAILABLE: [503, 'Service unavailable'],
} as const satisfies Record<ShareAnalyticsErrorCodeV1, readonly [number, string]>;

export class ShareAnalyticsError extends Error {
  readonly status: number;
  readonly code: ShareAnalyticsErrorCodeV1;
  readonly retryAfterSeconds: number | null;

  constructor(code: ShareAnalyticsErrorCodeV1, retryAfterSeconds: number | null = null) {
    const [status, message] = DEFINITIONS[code];
    super(message);
    this.name = 'ShareAnalyticsError';
    this.status = status;
    this.code = code;
    this.retryAfterSeconds =
      code === 'RATE_LIMITED' && retryAfterSeconds !== null
        ? Math.max(1, Math.ceil(retryAfterSeconds))
        : null;
  }
}
