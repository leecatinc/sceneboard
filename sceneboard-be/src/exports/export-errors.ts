export const EXPORT_FAILURE_DEFINITIONS_V1 = Object.freeze({
  EXPORT_INVALID_REQUEST: Object.freeze({
    httpStatus: 400,
    retryable: false,
    message: 'Invalid export request',
  }),
  EXPORT_UNAUTHENTICATED: Object.freeze({
    httpStatus: 401,
    retryable: false,
    message: 'Authentication is required',
  }),
  EXPORT_FORBIDDEN: Object.freeze({
    httpStatus: 403,
    retryable: false,
    message: 'Export is not allowed',
  }),
  EXPORT_NOT_FOUND: Object.freeze({
    httpStatus: 404,
    retryable: false,
    message: 'Board or revision not found',
  }),
  EXPORT_REQUIRED_CONTENT_UNSUPPORTED: Object.freeze({
    httpStatus: 422,
    retryable: false,
    message: 'Required content cannot be exported',
  }),
  EXPORT_BOUNDS_EXCEEDED: Object.freeze({
    httpStatus: 413,
    retryable: false,
    message: 'Export bounds exceeded',
  }),
  EXPORT_RATE_LIMITED: Object.freeze({
    httpStatus: 429,
    retryable: true,
    message: 'Export capacity is temporarily unavailable',
  }),
  EXPORT_RENDERER_UNAVAILABLE: Object.freeze({
    httpStatus: 503,
    retryable: true,
    message: 'Export renderer is unavailable',
  }),
  EXPORT_RENDER_TIMEOUT: Object.freeze({
    httpStatus: 504,
    retryable: true,
    message: 'Export timed out',
  }),
  EXPORT_ENCODE_FAILED: Object.freeze({
    httpStatus: 500,
    retryable: true,
    message: 'Export encoding failed',
  }),
  EXPORT_INTERNAL_ERROR: Object.freeze({
    httpStatus: 500,
    retryable: true,
    message: 'Export failed',
  }),
} as const);

export type ExportFailureCodeV1 = keyof typeof EXPORT_FAILURE_DEFINITIONS_V1;

export class ExportFailureV1 extends Error {
  readonly httpStatus: number;
  readonly retryable: boolean;
  override readonly message: string;

  constructor(
    readonly code: ExportFailureCodeV1,
    cause?: unknown,
  ) {
    const definition = EXPORT_FAILURE_DEFINITIONS_V1[code];
    super(definition.message, cause === undefined ? undefined : { cause });
    this.name = 'ExportFailureV1';
    this.httpStatus = definition.httpStatus;
    this.retryable = definition.retryable;
    this.message = definition.message;
  }

  toPayload(): {
    ok: false;
    error: { code: ExportFailureCodeV1; message: string; retryable: boolean };
  } {
    return {
      ok: false,
      error: { code: this.code, message: this.message, retryable: this.retryable },
    };
  }
}
