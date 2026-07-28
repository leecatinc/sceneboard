'use client';

import {
  BoardErrorParserV1,
  BoardIdParserV1,
  GlobalIdStringParserV1,
  MEDIA_MIME_TYPES_V1,
  MediaIngestResultSchemaV1,
  type BoardError,
  type MediaIngestResultV1,
  type MediaMimeV1,
} from '@sceneboard/board-schema';

import {
  type BoardBinaryAttemptV1,
  type BoardBinaryBindResultV1,
  type SessionRequestCoordinator,
} from '../auth/renewal-singleflight';

const MEDIA_UPLOAD_MAX_BYTES = 10_485_760;
const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';
const CLOSED_ERROR_STATUSES = new Set([400, 401, 403, 404, 409, 413, 422, 429, 503]);

export type PreparedMediaUploadV1 = Readonly<{
  attempt: BoardBinaryAttemptV1;
  contentDigest: string;
}>;

export type MediaUploadResultV1 =
  | { kind: 'ok'; value: MediaIngestResultV1 }
  | { kind: 'board_error'; error: BoardError }
  | { kind: 'commit_uncertain'; reason: 'transport' | 'response_contract' }
  | { kind: 'stale_attempt' }
  | { kind: 'unsupported_browser' };

const exactKeys = (value: object, keys: readonly string[]): boolean => {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
};

const base64 = (bytes: Uint8Array): string => {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

const digestBlob = async (blob: Blob): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return `sha-256=:${base64(new Uint8Array(digest))}:`;
};

const hasNoStore = (value: string | null): boolean =>
  value
    ?.split(',')
    .map((part) => part.trim().toLowerCase())
    .includes('no-store') ?? false;

const parseError = (body: unknown, response: Response, requestId: string): BoardError | null => {
  const status = response.status;
  if (
    !CLOSED_ERROR_STATUSES.has(status) ||
    response.redirected ||
    response.headers.get('content-type')?.toLowerCase() !== JSON_CONTENT_TYPE ||
    !hasNoStore(response.headers.get('cache-control')) ||
    response.headers.get('x-request-id') !== requestId ||
    body === null ||
    typeof body !== 'object' ||
    Array.isArray(body) ||
    !exactKeys(body, ['error'])
  )
    return null;
  const parsed = BoardErrorParserV1.parse((body as { error: unknown }).error);
  return parsed.ok && parsed.data.value.httpStatusHint === status ? parsed.data.value : null;
};

const parseSuccess = (
  body: unknown,
  response: Response,
  requestId: string,
): MediaIngestResultV1 | null => {
  if (
    (response.status !== 200 && response.status !== 201) ||
    response.redirected ||
    response.headers.get('content-type')?.toLowerCase() !== JSON_CONTENT_TYPE ||
    !hasNoStore(response.headers.get('cache-control')) ||
    response.headers.get('x-request-id') !== requestId ||
    body === null ||
    typeof body !== 'object' ||
    Array.isArray(body) ||
    !exactKeys(body, ['protocolVersion', 'type', 'requestId', 'result'])
  )
    return null;
  const envelope = body as {
    protocolVersion: unknown;
    type: unknown;
    requestId: unknown;
    result: unknown;
  };
  if (
    envelope.protocolVersion !== 1 ||
    envelope.type !== 'board.http.success' ||
    envelope.requestId !== requestId
  )
    return null;
  const result = MediaIngestResultSchemaV1.safeParse(envelope.result);
  if (
    !result.success ||
    result.data.requestId !== requestId ||
    (response.status === 201 && result.data.status !== 'created') ||
    (response.status === 200 && result.data.status !== 'replayed')
  )
    return null;
  return result.data;
};

export class BoardMediaUploadApi {
  constructor(private readonly coordinator: SessionRequestCoordinator) {}

  async bind(input: {
    boardId: string;
    file: Blob;
    requestId: string;
    idempotencyKey: string;
    csrfToken: string;
  }): Promise<
    | { kind: 'bound'; value: PreparedMediaUploadV1 }
    | Exclude<BoardBinaryBindResultV1, { kind: 'bound' }>
    | { kind: 'invalid_file' }
  > {
    const boardId = BoardIdParserV1.parse(input.boardId);
    const requestId = GlobalIdStringParserV1.parse(input.requestId);
    if (
      !boardId.ok ||
      !requestId.ok ||
      !/^[A-Za-z0-9._~-]{16,128}$/u.test(input.idempotencyKey) ||
      !MEDIA_MIME_TYPES_V1.includes(input.file.type as MediaMimeV1) ||
      input.file.size < 1 ||
      input.file.size > MEDIA_UPLOAD_MAX_BYTES
    )
      return { kind: 'invalid_file' };
    const blob = input.file.slice(0, input.file.size, input.file.type);
    const contentDigest = await digestBlob(blob);
    const result = await this.coordinator.bindBoardBinaryAttempt({
      requestId: requestId.data.value,
      path: `/api/v1/boards/${encodeURIComponent(boardId.data.value)}/media?requestId=${encodeURIComponent(requestId.data.value)}`,
      contentType: blob.type as MediaMimeV1,
      contentDigest,
      idempotencyKey: input.idempotencyKey,
      csrfToken: input.csrfToken,
      blob,
    });
    return result.kind === 'bound'
      ? { kind: 'bound', value: { attempt: result.attempt, contentDigest } }
      : result;
  }

  async upload(prepared: PreparedMediaUploadV1, signal: AbortSignal): Promise<MediaUploadResultV1> {
    const dispatched = await this.coordinator.dispatchBoardBinary(prepared.attempt, signal);
    if (dispatched.kind === 'transport_uncertain')
      return { kind: 'commit_uncertain', reason: 'transport' };
    if (dispatched.kind !== 'ok') return dispatched;
    const success = parseSuccess(
      dispatched.value.body,
      dispatched.value.response,
      prepared.attempt.requestId,
    );
    if (success !== null) return { kind: 'ok', value: success };
    const error = parseError(
      dispatched.value.body,
      dispatched.value.response,
      prepared.attempt.requestId,
    );
    if (error !== null) return { kind: 'board_error', error };
    return { kind: 'commit_uncertain', reason: 'response_contract' };
  }
}
