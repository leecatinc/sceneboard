import {
  BoardErrorParser,
  MediaIngestResultParserV1,
  type BoardError,
  type MediaIngestResultV1,
  type MediaMimeV1,
} from '@sceneboard/board-schema';
import { BoardSdkHttpClient, type BoardSdkHttpLocalErrorV1 } from '@sceneboard/board-sdk/http';

export type MediaIngestHttpSuccessV1 = Readonly<{
  protocolVersion: 1;
  type: 'board.http.success';
  requestId: string;
  result: MediaIngestResultV1;
}>;

export type MediaHttpResultV1 =
  | { ok: true; result: MediaIngestResultV1; metadata: null }
  | { ok: false; error: BoardError | BoardSdkHttpLocalErrorV1 };

export type ConnectionMediaHttpClientOptionsV1 = Readonly<{
  baseUrl: string;
  fetch: typeof fetch;
  timeoutMs: number;
  logger: {
    log(event: {
      route: string;
      attempt: number;
      durationMs: number;
      requestId: string;
      resultCode: string;
    }): void;
  };
}>;

const local = (error: BoardSdkHttpLocalErrorV1): MediaHttpResultV1 => ({ ok: false, error });

const exactRecord = (value: unknown, keys: readonly string[]): Record<string, unknown> | null => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
    ? record
    : null;
};

export class ConnectionMediaHttpClientV1 {
  constructor(private readonly options: ConnectionMediaHttpClientOptionsV1) {}

  async upload(
    input: Readonly<{
      boardId: string;
      requestId: string;
      idempotencyKey: string;
      accessToken: string;
      mime: MediaMimeV1;
      digestBase64: string;
      bytes: Buffer;
    }>,
    outerSignal?: AbortSignal,
  ): Promise<MediaHttpResultV1> {
    const timeoutSignal = AbortSignal.timeout(this.options.timeoutMs);
    const signal =
      outerSignal === undefined ? timeoutSignal : AbortSignal.any([outerSignal, timeoutSignal]);
    if (signal.aborted) return local({ code: 'CANCELLED', retryable: false });
    const url = new URL(
      `/api/v1/boards/${encodeURIComponent(input.boardId)}/media`,
      this.options.baseUrl,
    );
    url.search = new URLSearchParams({ requestId: input.requestId }).toString();
    const startedAt = performance.now();
    let response: Response;
    try {
      response = await this.options.fetch(url, {
        method: 'POST',
        redirect: 'manual',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${input.accessToken}`,
          'Content-Type': input.mime,
          'Content-Length': String(input.bytes.length),
          'Content-Digest': `sha-256=:${input.digestBase64}:`,
          'Idempotency-Key': input.idempotencyKey,
        },
        body: input.bytes as unknown as BodyInit,
        signal,
      });
    } catch {
      if (outerSignal?.aborted) return local({ code: 'CANCELLED', retryable: false });
      if (timeoutSignal.aborted)
        return local({ code: 'TIMEOUT', retryable: true, timeoutMs: this.options.timeoutMs });
      return local({ code: 'TRANSPORT_ERROR', retryable: true, phase: 'request' });
    }
    if (response.redirected || (response.status >= 300 && response.status < 400)) {
      await response.body?.cancel().catch(() => undefined);
      return local({ code: 'RESPONSE_INVALID', retryable: false, reason: 'status' });
    }
    if (response.headers.get('content-type')?.toLowerCase() !== 'application/json; charset=utf-8') {
      await response.body?.cancel().catch(() => undefined);
      return local({ code: 'RESPONSE_INVALID', retryable: false, reason: 'content_type' });
    }
    const successStatus = response.status === 200 || response.status === 201;
    const body = await BoardSdkHttpClient.readBoundedResponseBodyV1(
      response,
      successStatus ? 2_097_152 : 65_536,
      signal,
    );
    if (body === 'body_too_large')
      return local({ code: 'RESPONSE_INVALID', retryable: false, reason: 'body_too_large' });
    if (body === 'response') {
      if (outerSignal?.aborted) return local({ code: 'CANCELLED', retryable: false });
      if (timeoutSignal.aborted)
        return local({ code: 'TIMEOUT', retryable: true, timeoutMs: this.options.timeoutMs });
      return local({ code: 'TRANSPORT_ERROR', retryable: true, phase: 'response' });
    }
    if (response.headers.get('x-request-id') !== input.requestId)
      return local({ code: 'RESPONSE_INVALID', retryable: false, reason: 'correlation' });
    const parsed = BoardSdkHttpClient.parseStrictJsonBytesV1(body);
    if (!parsed.ok)
      return local({ code: 'RESPONSE_INVALID', retryable: false, reason: parsed.reason });
    if (successStatus) {
      const envelope = exactRecord(parsed.value, [
        'protocolVersion',
        'type',
        'requestId',
        'result',
      ]);
      const result = envelope === null ? null : MediaIngestResultParserV1.parse(envelope.result);
      if (
        envelope === null ||
        envelope.protocolVersion !== 1 ||
        envelope.type !== 'board.http.success' ||
        envelope.requestId !== input.requestId ||
        result === null ||
        !result.ok ||
        result.data.value.requestId !== input.requestId ||
        (response.status === 201 && result.data.value.status !== 'created') ||
        (response.status === 200 && result.data.value.status !== 'replayed')
      )
        return local({ code: 'RESPONSE_INVALID', retryable: false, reason: 'correlation' });
      this.options.logger.log({
        route: '/api/v1/boards/:boardId/media',
        attempt: 1,
        durationMs: performance.now() - startedAt,
        requestId: input.requestId,
        resultCode: result.data.value.status,
      });
      return { ok: true, result: result.data.value, metadata: null };
    }
    const envelope = exactRecord(parsed.value, ['error']);
    const error = envelope === null ? null : BoardErrorParser.parse(envelope.error);
    if (
      error === null ||
      !error.ok ||
      error.data.value.httpStatusHint !== response.status ||
      ![
        'INVALID_REQUEST',
        'UNAUTHENTICATED',
        'FORBIDDEN',
        'BOARD_NOT_FOUND',
        'IDEMPOTENCY_KEY_REUSED',
        'IDEMPOTENCY_RESULT_EXPIRED',
        'PAYLOAD_TOO_LARGE',
        'INVALID_MEDIA_UPLOAD',
        'RATE_LIMITED',
        'SERVICE_UNAVAILABLE',
      ].includes(error.data.value.code)
    )
      return local({ code: 'RESPONSE_INVALID', retryable: false, reason: 'status' });
    this.options.logger.log({
      route: '/api/v1/boards/:boardId/media',
      attempt: 1,
      durationMs: performance.now() - startedAt,
      requestId: input.requestId,
      resultCode: error.data.value.code,
    });
    return { ok: false, error: error.data.value };
  }
}
