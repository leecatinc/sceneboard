'use client';

import type { SessionRequestCoordinator } from '../auth/renewal-singleflight';

export const BOARD_EXPORT_FORMATS_V1 = ['pdf', 'pptx'] as const;
export type BoardExportFormatV1 = (typeof BOARD_EXPORT_FORMATS_V1)[number];

export const BOARD_EXPORT_FAILURES_V1 = Object.freeze({
  EXPORT_INVALID_REQUEST: Object.freeze({
    status: 400,
    message: 'Invalid export request',
    retryable: false,
  }),
  EXPORT_UNAUTHENTICATED: Object.freeze({
    status: 401,
    message: 'Authentication is required',
    retryable: false,
  }),
  EXPORT_FORBIDDEN: Object.freeze({
    status: 403,
    message: 'Export is not allowed',
    retryable: false,
  }),
  EXPORT_NOT_FOUND: Object.freeze({
    status: 404,
    message: 'Board or revision not found',
    retryable: false,
  }),
  EXPORT_REQUIRED_CONTENT_UNSUPPORTED: Object.freeze({
    status: 422,
    message: 'Required content cannot be exported',
    retryable: false,
  }),
  EXPORT_BOUNDS_EXCEEDED: Object.freeze({
    status: 413,
    message: 'Export bounds exceeded',
    retryable: false,
  }),
  EXPORT_RATE_LIMITED: Object.freeze({
    status: 429,
    message: 'Export capacity is temporarily unavailable',
    retryable: true,
  }),
  EXPORT_RENDERER_UNAVAILABLE: Object.freeze({
    status: 503,
    message: 'Export renderer is unavailable',
    retryable: true,
  }),
  EXPORT_RENDER_TIMEOUT: Object.freeze({
    status: 504,
    message: 'Export timed out',
    retryable: true,
  }),
  EXPORT_ENCODE_FAILED: Object.freeze({
    status: 500,
    message: 'Export encoding failed',
    retryable: true,
  }),
  EXPORT_INTERNAL_ERROR: Object.freeze({
    status: 500,
    message: 'Export failed',
    retryable: true,
  }),
} as const);

export type BoardExportFailureCodeV1 = keyof typeof BOARD_EXPORT_FAILURES_V1;

export type BoardExportFailureV1 = Readonly<{
  code: BoardExportFailureCodeV1 | 'EXPORT_RESPONSE_INVALID' | 'EXPORT_BROWSER_UNAVAILABLE';
  retryable: boolean;
}>;

export type BoardExportResultV1 =
  | Readonly<{
      kind: 'ok';
      value: {
        format: BoardExportFormatV1;
        bytes: Uint8Array;
        fileName: string;
        contentType: string;
      };
    }>
  | Readonly<{ kind: 'error'; error: BoardExportFailureV1 }>;

export type BoardExportDownloadPortV1 = Readonly<{
  createObjectUrl(blob: Blob): string;
  revokeObjectUrl(url: string): void;
  clickDownload(input: { url: string; fileName: string }): void;
}>;

const CONTENT_TYPES = Object.freeze({
  pdf: 'application/pdf',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
} as const satisfies Readonly<Record<BoardExportFormatV1, string>>);

const BOARD_EXPORT_DEADLINE_MS_V1 = 120_000;

const exactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
};

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const invalid = (): BoardExportResultV1 =>
  Object.freeze({
    kind: 'error',
    error: Object.freeze({ code: 'EXPORT_RESPONSE_INVALID', retryable: false }),
  });

const browserUnavailable = (): BoardExportResultV1 =>
  Object.freeze({
    kind: 'error',
    error: Object.freeze({ code: 'EXPORT_BROWSER_UNAVAILABLE', retryable: false }),
  });

const renderTimeout = (): BoardExportResultV1 =>
  Object.freeze({
    kind: 'error',
    error: Object.freeze({ code: 'EXPORT_RENDER_TIMEOUT', retryable: true }),
  });

const isRedirectResponse = (response: Response): boolean =>
  response.redirected ||
  response.type === 'opaqueredirect' ||
  (response.status >= 300 && response.status <= 399);

const parseFailure = (status: number, body: unknown): BoardExportResultV1 => {
  if (
    !object(body) ||
    !exactKeys(body, ['ok', 'error']) ||
    body.ok !== false ||
    !object(body.error)
  )
    return invalid();
  if (!exactKeys(body.error, ['code', 'message', 'retryable'])) return invalid();
  const code = body.error.code;
  if (typeof code !== 'string' || !(code in BOARD_EXPORT_FAILURES_V1)) return invalid();
  const definition = BOARD_EXPORT_FAILURES_V1[code as BoardExportFailureCodeV1];
  if (
    status !== definition.status ||
    body.error.message !== definition.message ||
    body.error.retryable !== definition.retryable
  )
    return invalid();
  return Object.freeze({
    kind: 'error',
    error: Object.freeze({
      code: code as BoardExportFailureCodeV1,
      retryable: definition.retryable,
    }),
  });
};

const parseFileName = (value: string | null, format: BoardExportFormatV1): string | null => {
  if (value === null) return null;
  const match = /^attachment; filename="([A-Za-z0-9][A-Za-z0-9._-]{0,110})"$/u.exec(value);
  if (match === null) return null;
  const fileName = match[1];
  if (fileName === undefined) return null;
  return fileName.endsWith(`.${format}`) && !fileName.includes('..') ? fileName : null;
};

const signatureMatches = (format: BoardExportFormatV1, bytes: Uint8Array): boolean =>
  format === 'pdf'
    ? bytes.byteLength >= 5 &&
      bytes[0] === 0x25 &&
      bytes[1] === 0x50 &&
      bytes[2] === 0x44 &&
      bytes[3] === 0x46 &&
      bytes[4] === 0x2d
    : bytes.byteLength >= 4 &&
      bytes[0] === 0x50 &&
      bytes[1] === 0x4b &&
      bytes[2] === 0x03 &&
      bytes[3] === 0x04;

export class BoardExportApi {
  constructor(private readonly coordinator: SessionRequestCoordinator) {}

  async export(
    input: Readonly<{
      boardId: string;
      revisionId: string;
      format: BoardExportFormatV1;
      signal: AbortSignal;
    }>,
  ): Promise<BoardExportResultV1> {
    if (
      !/^[A-Za-z0-9_-]{1,128}$/u.test(input.boardId) ||
      !/^[A-Za-z0-9_-]{1,128}$/u.test(input.revisionId) ||
      !BOARD_EXPORT_FORMATS_V1.includes(input.format)
    )
      throw new TypeError('invalid board export input');
    const csrfToken = this.coordinator.currentSnapshot()?.csrfToken;
    if (csrfToken === undefined) return browserUnavailable();
    const dispatchController = new AbortController();
    let deadlineExpired = false;
    let settleDeadline!: () => void;
    let settleCallerCancellation!: () => void;
    const deadline = new Promise<{ kind: 'deadline' }>((resolve) => {
      settleDeadline = () => resolve({ kind: 'deadline' });
    });
    const callerCancellation = new Promise<{ kind: 'caller_cancelled' }>((resolve) => {
      settleCallerCancellation = () => resolve({ kind: 'caller_cancelled' });
    });
    const onCallerCancellation = (): void => {
      settleCallerCancellation();
      dispatchController.abort(input.signal.reason);
    };
    input.signal.addEventListener('abort', onCallerCancellation, { once: true });
    if (input.signal.aborted) onCallerCancellation();
    const timer = setTimeout(() => {
      deadlineExpired = true;
      settleDeadline();
      dispatchController.abort(new DOMException('Board export timed out', 'TimeoutError'));
    }, BOARD_EXPORT_DEADLINE_MS_V1);
    const dispatch = this.coordinator
      .dispatchShared({
        path: `/api/v1/boards/${encodeURIComponent(input.boardId)}/exports`,
        method: 'POST',
        body: { format: input.format, revisionId: input.revisionId },
        csrfToken,
        responseKind: 'export',
        signal: dispatchController.signal,
      })
      .then(
        (value) => ({ kind: 'dispatched' as const, value }),
        () => ({ kind: 'dispatch_failed' as const }),
      );
    let outcome: Awaited<typeof dispatch> | { kind: 'deadline' } | { kind: 'caller_cancelled' };
    try {
      outcome = await Promise.race([dispatch, deadline, callerCancellation]);
    } finally {
      clearTimeout(timer);
      input.signal.removeEventListener('abort', onCallerCancellation);
    }
    if (deadlineExpired || outcome.kind === 'deadline') return renderTimeout();
    if (outcome.kind === 'caller_cancelled' || outcome.kind === 'dispatch_failed')
      return browserUnavailable();
    const dispatched = outcome.value;
    if (dispatched.kind !== 'ok') return browserUnavailable();
    const { response, body, bytes } = dispatched.value;
    if (isRedirectResponse(response)) {
      await response.body?.cancel().catch(() => undefined);
      return invalid();
    }
    if (!response.ok) return parseFailure(response.status, body);
    if (response.status !== 200 || body !== null) return invalid();
    const contentType = CONTENT_TYPES[input.format];
    const fileName = parseFileName(response.headers.get('content-disposition'), input.format);
    const declaredLength = response.headers.get('content-length');
    if (
      response.headers.get('content-type') !== contentType ||
      response.headers.get('cache-control') !== 'no-store, private' ||
      response.headers.get('pragma') !== 'no-cache' ||
      response.headers.get('x-content-type-options') !== 'nosniff' ||
      fileName === null ||
      declaredLength === null ||
      !/^[1-9][0-9]{0,9}$/u.test(declaredLength) ||
      Number(declaredLength) !== bytes.byteLength ||
      !signatureMatches(input.format, bytes)
    )
      return invalid();
    return Object.freeze({
      kind: 'ok',
      value: Object.freeze({ format: input.format, bytes, fileName, contentType }),
    });
  }
}

export const publishBoardExportDownloadV1 = (
  result: Extract<BoardExportResultV1, { kind: 'ok' }>['value'],
  port: BoardExportDownloadPortV1,
): void => {
  const payload = new Uint8Array(result.bytes.byteLength);
  payload.set(result.bytes);
  const url = port.createObjectUrl(new Blob([payload.buffer], { type: result.contentType }));
  try {
    port.clickDownload({ url, fileName: result.fileName });
  } finally {
    port.revokeObjectUrl(url);
  }
};
