import {
  BoardOperationRequestParserV1,
  BOARD_DOCUMENT_LIMITS_V2,
  MutationRequestParserV1,
  MutationRequestParserV2,
  type BoardErrorV1,
  type BoardError,
  type ArtifactId,
  type ArtifactRequestCapabilityV1,
  type ArtifactReferenceV1,
  type BoardId,
  type BoardOperationRequestV1,
  type BoardOperationResultDataV1,
  type BoardOperationResultV1,
  type MutationRequestV1,
  type MutationRequestV2,
  type MutationResultV1,
  type RequestId,
  type RevisionId,
  type IdempotencyKey,
} from '@sceneboard/board-schema';

import {
  parseBoardHttpResultV1,
  parseBoardDocumentHttpResultV2,
  parseBoardOperationHttpResultV2,
  type BoardHttpMetadataV1,
  type BoardHttpResultParseFailureReasonV1,
} from './http-result.parser.js';
import { readBoundedResponseBodyV1 } from './bounded-response.js';
import { parseStrictJsonBytesV1 } from './strict-json-response.js';
import { createMonotonicDeadlineV1 } from './monotonic-deadline.js';
import { protectedRetryDelayMsV1, sleepWithinDeadlineV1 } from './retry-policy.js';

export type BoardSdkHttpLocalErrorV1 =
  | { code: 'CANCELLED'; retryable: false }
  | { code: 'TIMEOUT'; retryable: true; timeoutMs: number }
  | { code: 'TRANSPORT_ERROR'; retryable: true; phase: 'credential' | 'request' | 'response' }
  | {
      code: 'RESPONSE_INVALID';
      retryable: false;
      reason:
        | BoardHttpResultParseFailureReasonV1
        | 'status'
        | 'content_type'
        | 'body_too_large'
        | 'correlation';
    };

type ResultEnvelopeFor<K extends string> =
  | (Omit<BoardOperationResultV1, 'result'> & {
      result: BoardOperationResultDataV1 & { type: K };
    })
  | (Omit<MutationResultV1, 'result'> & {
      result: MutationResultV1['result'] & { type: K };
    });

export type BoardSdkHttpResultV1<K extends string> =
  | { ok: true; result: ResultEnvelopeFor<K>; metadata: BoardHttpMetadataV1 }
  | { ok: false; error: BoardErrorV1 | BoardSdkHttpLocalErrorV1 };

export type BoardSdkDocumentHttpResultV2 =
  | {
      ok: true;
      result: import('@sceneboard/board-schema').MutationResultV2 & {
        result: Extract<
          import('@sceneboard/board-schema').MutationResultV2['result'],
          { type: 'document.replace' }
        >;
      };
      metadata: { history: null };
    }
  | { ok: false; error: BoardError | BoardSdkHttpLocalErrorV1 };

export type BoardSdkDocumentReadHttpResultV2<K extends 'board.get' | 'history.get'> =
  | { ok: true; result: ResultEnvelopeFor<K>; metadata: BoardHttpMetadataV1 }
  | { ok: false; error: BoardError | BoardSdkHttpLocalErrorV1 };

export type BoardSdkHttpLogEventV1 = {
  route: string;
  attempt: number;
  durationMs: number;
  requestId: RequestId;
  resultCode: string;
};

export type BoardSdkHttpClientOptionsV1 = {
  baseUrl: string;
  fetch: typeof fetch;
  bearerTokenProvider: () => string | Promise<string>;
  timeoutPolicy: { timeoutMs: number };
  logger: { log(event: BoardSdkHttpLogEventV1): void };
};

export type BoardArtifactPutSourceV1 = {
  boardId: BoardId;
  expectedRevisionId: RevisionId;
  idempotencyKey: IdempotencyKey;
  artifactId: ArtifactId | null;
  html: string;
  css: string | null;
  javascript: string | null;
  requestedCapabilities: readonly ArtifactRequestCapabilityV1[];
};

type OperationRequest<K extends BoardOperationRequestV1['type']> = BoardOperationRequestV1 & {
  type: K;
};

type CallSpec<K extends string> = {
  method: 'GET' | 'POST';
  routeTemplate: string;
  path: string;
  query?: URLSearchParams;
  body: Uint8Array | null;
  requestId: RequestId;
  resultType: K;
  boardId?: BoardId;
  artifact?: ArtifactReferenceV1;
  revisionId?: MutationRequestV1['expectedRevisionId'];
  retryKind: 'read' | 'mutation';
  profile?: 'v1' | 'document-v2';
};

const SUCCESS_BODY_LIMIT = 2_097_152;
const ERROR_BODY_LIMIT = 65_536;
const DOCUMENT_MEDIA_TYPE = 'application/vnd.sceneboard.document+json;version=2';
const TOKEN_PATTERN = /^lcbg_v1\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/;

const localFailure = <K extends string>(
  error: BoardSdkHttpLocalErrorV1,
): Extract<BoardSdkHttpResultV1<K>, { ok: false }> => ({
  ok: false,
  error,
});

const validateBaseUrl = (value: string): string => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError('baseUrl must be a canonical bare origin');
  }
  const loopback =
    url.hostname === '127.0.0.1' || url.hostname === '[::1]' || url.hostname === '::1';
  if (
    url.origin !== value ||
    url.pathname !== '/' ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== '' ||
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
  ) {
    throw new TypeError('baseUrl must be HTTPS or an exact HTTP loopback origin');
  }
  return url.origin;
};

const retryDelayFromError = (error: BoardError): number | null => {
  const seconds =
    error.code === 'RATE_LIMITED'
      ? error.details.retryAfterSeconds
      : error.code === 'SERVICE_UNAVAILABLE'
        ? error.details.retryAfterSeconds
        : null;
  return seconds === null ? null : seconds * 1_000;
};

const shouldRetryError = (error: BoardError): boolean =>
  error.retryable && (error.code === 'RATE_LIMITED' || error.code === 'SERVICE_UNAVAILABLE');

export class BoardSdkHttpClient {
  static readonly readBoundedResponseBodyV1 = readBoundedResponseBodyV1;
  static readonly parseStrictJsonBytesV1 = parseStrictJsonBytesV1;

  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;
  readonly #bearerTokenProvider: BoardSdkHttpClientOptionsV1['bearerTokenProvider'];
  readonly #timeoutMs: number;
  readonly #logger: BoardSdkHttpClientOptionsV1['logger'];

  constructor(options: BoardSdkHttpClientOptionsV1) {
    this.#baseUrl = validateBaseUrl(options.baseUrl);
    if (typeof options.fetch !== 'function') throw new TypeError('fetch is required');
    if (typeof options.bearerTokenProvider !== 'function')
      throw new TypeError('bearerTokenProvider is required');
    if (
      !Number.isSafeInteger(options.timeoutPolicy?.timeoutMs) ||
      options.timeoutPolicy.timeoutMs < 1
    ) {
      throw new TypeError('timeoutPolicy.timeoutMs must be a positive safe integer');
    }
    if (typeof options.logger?.log !== 'function') throw new TypeError('logger.log is required');
    this.#fetch = options.fetch;
    this.#bearerTokenProvider = options.bearerTokenProvider;
    this.#timeoutMs = options.timeoutPolicy.timeoutMs;
    this.#logger = options.logger;
  }

  listBoards(
    request: OperationRequest<'board.list'>,
    signal?: AbortSignal,
  ): Promise<BoardSdkHttpResultV1<'board.list'>> {
    const parsed = this.#operation(request, 'board.list');
    const query = new URLSearchParams({
      requestId: parsed.requestId,
      limit: String(parsed.limit),
      includeArchived: String(parsed.includeArchived),
    });
    if (parsed.cursor !== null) query.set('cursor', parsed.cursor);
    return this.#call(
      {
        method: 'GET',
        routeTemplate: '/api/v1/boards',
        path: '/api/v1/boards',
        query,
        body: null,
        requestId: parsed.requestId,
        resultType: 'board.list',
        retryKind: 'read',
      },
      signal,
    );
  }

  getBoard(
    request: OperationRequest<'board.get'>,
    signal?: AbortSignal,
  ): Promise<BoardSdkHttpResultV1<'board.get'>> {
    const parsed = this.#operation(request, 'board.get');
    return this.#operationGet(
      parsed,
      `/api/v1/boards/${parsed.boardId}`,
      '/api/v1/boards/:boardId',
      signal,
    );
  }

  getDocumentBoard(
    request: OperationRequest<'board.get'>,
    signal?: AbortSignal,
  ): Promise<BoardSdkDocumentReadHttpResultV2<'board.get'>> {
    const parsed = this.#operation(request, 'board.get');
    return this.#call(
      {
        method: 'GET',
        routeTemplate: '/api/v1/boards/:boardId',
        path: `/api/v1/boards/${parsed.boardId}`,
        query: new URLSearchParams({ requestId: parsed.requestId }),
        body: null,
        requestId: parsed.requestId,
        resultType: 'board.get',
        boardId: parsed.boardId,
        retryKind: 'read',
        profile: 'document-v2',
      },
      signal,
    ) as Promise<BoardSdkDocumentReadHttpResultV2<'board.get'>>;
  }

  createBoard(
    request: OperationRequest<'board.create'>,
    signal?: AbortSignal,
  ): Promise<BoardSdkHttpResultV1<'board.create'>> {
    const parsed = this.#operation(request, 'board.create');
    return this.#call(
      {
        method: 'POST',
        routeTemplate: '/api/v1/boards',
        path: '/api/v1/boards',
        body: this.#operationBytes(parsed),
        requestId: parsed.requestId,
        resultType: 'board.create',
        retryKind: 'mutation',
      },
      signal,
    );
  }

  archiveBoard(
    request: OperationRequest<'board.archive'>,
    signal?: AbortSignal,
  ): Promise<BoardSdkHttpResultV1<'board.archive'>> {
    const parsed = this.#operation(request, 'board.archive');
    return this.#call(
      {
        method: 'POST',
        routeTemplate: '/api/v1/boards/:boardId/archive',
        path: `/api/v1/boards/${parsed.boardId}/archive`,
        body: this.#operationBytes(parsed),
        requestId: parsed.requestId,
        resultType: 'board.archive',
        boardId: parsed.boardId,
        retryKind: 'mutation',
      },
      signal,
    );
  }

  getCapabilities(
    request: OperationRequest<'capabilities.get'>,
    signal?: AbortSignal,
  ): Promise<BoardSdkHttpResultV1<'capabilities.get'>> {
    const parsed = this.#operation(request, 'capabilities.get');
    return this.#operationGet(
      parsed,
      `/api/v1/boards/${parsed.boardId}/capabilities`,
      '/api/v1/boards/:boardId/capabilities',
      signal,
    );
  }

  mutateBoard<K extends MutationRequestV1['command']['type']>(
    request: MutationRequestV1 & { command: Extract<MutationRequestV1['command'], { type: K }> },
    signal?: AbortSignal,
  ): Promise<BoardSdkHttpResultV1<K>> {
    const parsed = MutationRequestParserV1.parse(request);
    if (!parsed.ok || parsed.data.value.command.type !== request.command.type)
      throw new TypeError('invalid D1 mutation request');
    return this.#call(
      {
        method: 'POST',
        routeTemplate: '/api/v1/boards/:boardId/mutations',
        path: `/api/v1/boards/${parsed.data.value.boardId}/mutations`,
        body: parsed.data.canonicalBytes,
        requestId: parsed.data.value.requestId,
        resultType: request.command.type,
        boardId: parsed.data.value.boardId,
        retryKind: 'mutation',
      },
      signal,
    ) as Promise<BoardSdkHttpResultV1<K>>;
  }

  mutateDocument(
    request: MutationRequestV2 & {
      command: Extract<MutationRequestV2['command'], { type: 'document.replace' }>;
    },
    signal?: AbortSignal,
  ): Promise<BoardSdkDocumentHttpResultV2> {
    const parsed = MutationRequestParserV2.parse(request);
    if (!parsed.ok || parsed.data.value.command.type !== 'document.replace')
      throw new TypeError('invalid document.replace request');
    return this.#call(
      {
        method: 'POST',
        routeTemplate: '/api/v1/boards/:boardId/mutations',
        path: `/api/v1/boards/${parsed.data.value.boardId}/mutations`,
        body: parsed.data.canonicalBytes,
        requestId: parsed.data.value.requestId,
        resultType: 'document.replace',
        boardId: parsed.data.value.boardId,
        retryKind: 'mutation',
        profile: 'document-v2',
      },
      signal,
    ) as Promise<BoardSdkDocumentHttpResultV2>;
  }

  restoreRevision(
    request: MutationRequestV1 & {
      command: Extract<MutationRequestV1['command'], { type: 'scene.restore' }>;
    },
    signal?: AbortSignal,
  ): Promise<BoardSdkHttpResultV1<'scene.restore'>> {
    const parsed = MutationRequestParserV1.parse(request);
    if (!parsed.ok || parsed.data.value.command.type !== 'scene.restore')
      throw new TypeError('invalid scene.restore request');
    const body = new TextEncoder().encode(
      JSON.stringify({
        protocolVersion: 1,
        requestId: parsed.data.value.requestId,
        idempotencyKey: parsed.data.value.idempotencyKey,
        expectedRevisionId: parsed.data.value.expectedRevisionId,
        confirm: true,
      }),
    );
    return this.#call(
      {
        method: 'POST',
        routeTemplate: '/api/v1/boards/:boardId/revisions/:revisionId/restore',
        path: `/api/v1/boards/${parsed.data.value.boardId}/revisions/${parsed.data.value.command.sourceRevisionId}/restore`,
        body,
        requestId: parsed.data.value.requestId,
        resultType: 'scene.restore',
        boardId: parsed.data.value.boardId,
        revisionId: parsed.data.value.command.sourceRevisionId,
        retryKind: 'mutation',
      },
      signal,
    );
  }

  listHistory(
    request: OperationRequest<'history.list'>,
    signal?: AbortSignal,
  ): Promise<BoardSdkHttpResultV1<'history.list'>> {
    const parsed = this.#operation(request, 'history.list');
    const query = new URLSearchParams({ requestId: parsed.requestId, limit: String(parsed.limit) });
    if (parsed.cursor !== null) query.set('cursor', parsed.cursor);
    return this.#call(
      {
        method: 'GET',
        routeTemplate: '/api/v1/boards/:boardId/revisions',
        path: `/api/v1/boards/${parsed.boardId}/revisions`,
        query,
        body: null,
        requestId: parsed.requestId,
        resultType: 'history.list',
        boardId: parsed.boardId,
        retryKind: 'read',
      },
      signal,
    );
  }

  getHistory(
    request: OperationRequest<'history.get'>,
    signal?: AbortSignal,
  ): Promise<BoardSdkHttpResultV1<'history.get'>> {
    const parsed = this.#operation(request, 'history.get');
    return this.#call(
      {
        method: 'GET',
        routeTemplate: '/api/v1/boards/:boardId/revisions/:revisionId',
        path: `/api/v1/boards/${parsed.boardId}/revisions/${parsed.revisionId}`,
        query: new URLSearchParams({ requestId: parsed.requestId }),
        body: null,
        requestId: parsed.requestId,
        resultType: 'history.get',
        boardId: parsed.boardId,
        revisionId: parsed.revisionId,
        retryKind: 'read',
      },
      signal,
    );
  }

  getDocumentHistory(
    request: OperationRequest<'history.get'>,
    signal?: AbortSignal,
  ): Promise<BoardSdkDocumentReadHttpResultV2<'history.get'>> {
    const parsed = this.#operation(request, 'history.get');
    return this.#call(
      {
        method: 'GET',
        routeTemplate: '/api/v1/boards/:boardId/revisions/:revisionId',
        path: `/api/v1/boards/${parsed.boardId}/revisions/${parsed.revisionId}`,
        query: new URLSearchParams({ requestId: parsed.requestId }),
        body: null,
        requestId: parsed.requestId,
        resultType: 'history.get',
        boardId: parsed.boardId,
        revisionId: parsed.revisionId,
        retryKind: 'read',
        profile: 'document-v2',
      },
      signal,
    ) as Promise<BoardSdkDocumentReadHttpResultV2<'history.get'>>;
  }

  getArtifact(
    request: OperationRequest<'artifact.get'>,
    signal?: AbortSignal,
  ): Promise<BoardSdkHttpResultV1<'artifact.get'>> {
    const parsed = this.#operation(request, 'artifact.get');
    return this.#call(
      {
        method: 'GET',
        routeTemplate: '/api/v1/boards/:boardId/artifacts/:artifactId/versions/:versionId',
        path: `/api/v1/boards/${parsed.boardId}/artifacts/${parsed.artifact.artifactId}/versions/${parsed.artifact.versionId}`,
        query: new URLSearchParams({ requestId: parsed.requestId }),
        body: null,
        requestId: parsed.requestId,
        resultType: 'artifact.get',
        boardId: parsed.boardId,
        artifact: parsed.artifact,
        retryKind: 'read',
      },
      signal,
    );
  }

  putArtifact(
    requestId: RequestId,
    source: BoardArtifactPutSourceV1,
    signal?: AbortSignal,
  ): Promise<BoardSdkHttpResultV1<'artifact.publish'>> {
    const body = new TextEncoder().encode(
      JSON.stringify({
        boardId: source.boardId,
        expectedRevisionId: source.expectedRevisionId,
        idempotencyKey: source.idempotencyKey,
        artifactId: source.artifactId,
        html: source.html,
        css: source.css,
        javascript: source.javascript,
        requestedCapabilities: source.requestedCapabilities,
      }),
    );
    return this.#call(
      {
        method: 'POST',
        routeTemplate: '/api/v1/boards/:boardId/artifacts',
        path: `/api/v1/boards/${source.boardId}/artifacts`,
        body,
        requestId,
        resultType: 'artifact.publish',
        boardId: source.boardId,
        retryKind: 'mutation',
      },
      signal,
    );
  }

  getInteraction(
    request: OperationRequest<'hitl.read'>,
    signal?: AbortSignal,
  ): Promise<BoardSdkHttpResultV1<'hitl.read'>> {
    const parsed = this.#operation(request, 'hitl.read');
    const query = new URLSearchParams({ requestId: parsed.requestId });
    if (parsed.wait !== null) {
      query.set('afterStateUpdatedAt', parsed.wait.afterStateUpdatedAt);
      query.set('timeoutMs', String(parsed.wait.timeoutMs));
    }
    return this.#call(
      {
        method: 'GET',
        routeTemplate: '/api/v1/boards/:boardId/interactions/:hitlRequestId',
        path: `/api/v1/boards/${parsed.boardId}/interactions/${parsed.hitlRequestId}`,
        query,
        body: null,
        requestId: parsed.requestId,
        resultType: 'hitl.read',
        boardId: parsed.boardId,
        retryKind: 'read',
      },
      signal,
    );
  }

  #operation<K extends BoardOperationRequestV1['type']>(
    request: OperationRequest<K>,
    kind: K,
  ): OperationRequest<K> {
    const parsed = BoardOperationRequestParserV1.parse(request);
    if (!parsed.ok || parsed.data.value.type !== kind)
      throw new TypeError(`invalid ${kind} request`);
    return parsed.data.value as OperationRequest<K>;
  }

  #operationBytes(request: BoardOperationRequestV1): Uint8Array {
    const parsed = BoardOperationRequestParserV1.parse(request);
    if (!parsed.ok) throw new TypeError('invalid D1 operation request');
    return parsed.data.canonicalBytes;
  }

  #operationGet<K extends 'board.get' | 'capabilities.get'>(
    request: OperationRequest<K>,
    path: string,
    routeTemplate: string,
    signal?: AbortSignal,
  ): Promise<BoardSdkHttpResultV1<K>> {
    return this.#call(
      {
        method: 'GET',
        routeTemplate,
        path,
        query: new URLSearchParams({ requestId: request.requestId }),
        body: null,
        requestId: request.requestId,
        resultType: request.type,
        boardId: request.boardId,
        retryKind: 'read',
      },
      signal,
    );
  }

  async #call<K extends string>(
    spec: CallSpec<K>,
    outerSignal?: AbortSignal,
  ): Promise<BoardSdkHttpResultV1<K>> {
    const deadline = createMonotonicDeadlineV1(this.#timeoutMs, outerSignal);
    const maximumAttempts = spec.retryKind === 'read' ? 3 : 2;
    try {
      for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
        if (deadline.signal.aborted) {
          return deadline.timedOut()
            ? localFailure({ code: 'TIMEOUT', retryable: true, timeoutMs: this.#timeoutMs })
            : localFailure({ code: 'CANCELLED', retryable: false });
        }
        const startedAt = performance.now();
        let token: string;
        try {
          token = await this.#bearerTokenProvider();
        } catch {
          return localFailure({ code: 'TRANSPORT_ERROR', retryable: true, phase: 'credential' });
        }
        if (!TOKEN_PATTERN.test(token)) {
          return localFailure({ code: 'TRANSPORT_ERROR', retryable: true, phase: 'credential' });
        }
        const url = new URL(spec.path, this.#baseUrl);
        if (spec.query !== undefined) url.search = spec.query.toString();
        let response: Response;
        try {
          response = await this.#fetch(url, {
            method: spec.method,
            redirect: 'manual',
            headers: {
              Accept: 'application/json',
              Authorization: `Bearer ${token}`,
              'X-Request-Id': spec.requestId,
              ...(spec.body === null
                ? {}
                : {
                    'Content-Type':
                      spec.profile === 'document-v2' ? DOCUMENT_MEDIA_TYPE : 'application/json',
                  }),
            },
            ...(spec.body === null ? {} : { body: spec.body.slice().buffer as ArrayBuffer }),
            signal: deadline.signal,
          });
        } catch {
          const result = deadline.signal.aborted
            ? deadline.timedOut()
              ? localFailure<K>({ code: 'TIMEOUT', retryable: true, timeoutMs: this.#timeoutMs })
              : localFailure<K>({ code: 'CANCELLED', retryable: false })
            : localFailure<K>({ code: 'TRANSPORT_ERROR', retryable: true, phase: 'request' });
          if (!result.error.retryable || attempt >= maximumAttempts) return result;
          const delay = protectedRetryDelayMsV1(attempt);
          if (!(await sleepWithinDeadlineV1(delay, deadline.remainingMs, deadline.signal)))
            return result;
          continue;
        } finally {
          token = '';
        }
        if (response.redirected || (response.status >= 300 && response.status < 400)) {
          await response.body?.cancel().catch(() => undefined);
          return localFailure({ code: 'RESPONSE_INVALID', retryable: false, reason: 'status' });
        }
        if (
          response.headers.get('content-type')?.toLowerCase() !== 'application/json; charset=utf-8'
        ) {
          await response.body?.cancel().catch(() => undefined);
          return localFailure({
            code: 'RESPONSE_INVALID',
            retryable: false,
            reason: 'content_type',
          });
        }
        const cap =
          response.status >= 200 && response.status < 300
            ? spec.profile === 'document-v2'
              ? BOARD_DOCUMENT_LIMITS_V2.maxDocumentEnvelopeBytes
              : SUCCESS_BODY_LIMIT
            : ERROR_BODY_LIMIT;
        const bytes = await readBoundedResponseBodyV1(response, cap, deadline.signal);
        if (bytes === 'body_too_large')
          return localFailure({
            code: 'RESPONSE_INVALID',
            retryable: false,
            reason: 'body_too_large',
          });
        if (bytes === 'response') {
          const result = deadline.signal.aborted
            ? deadline.timedOut()
              ? localFailure<K>({ code: 'TIMEOUT', retryable: true, timeoutMs: this.#timeoutMs })
              : localFailure<K>({ code: 'CANCELLED', retryable: false })
            : localFailure<K>({ code: 'TRANSPORT_ERROR', retryable: true, phase: 'response' });
          if (!result.error.retryable || attempt >= maximumAttempts) return result;
          const delay = protectedRetryDelayMsV1(attempt);
          if (!(await sleepWithinDeadlineV1(delay, deadline.remainingMs, deadline.signal)))
            return result;
          continue;
        }
        if (response.headers.get('x-request-id') !== spec.requestId) {
          return localFailure({
            code: 'RESPONSE_INVALID',
            retryable: false,
            reason: 'correlation',
          });
        }
        const parsed =
          spec.profile === 'document-v2' && spec.resultType === 'document.replace'
            ? parseBoardDocumentHttpResultV2(bytes, {
                status: response.status,
                requestId: spec.requestId,
                boardId: spec.boardId as BoardId,
              })
            : spec.profile === 'document-v2'
              ? parseBoardOperationHttpResultV2(bytes, {
                  status: response.status,
                  requestId: spec.requestId,
                  resultType: spec.resultType as BoardOperationResultDataV1['type'],
                  ...(spec.boardId === undefined ? {} : { boardId: spec.boardId }),
                  ...(spec.revisionId === undefined ? {} : { revisionId: spec.revisionId }),
                })
              : parseBoardHttpResultV1(bytes, {
                  status: response.status,
                  requestId: spec.requestId,
                  resultType: spec.resultType as
                    | BoardOperationResultDataV1['type']
                    | MutationResultV1['result']['type'],
                  ...(spec.boardId === undefined ? {} : { boardId: spec.boardId }),
                  ...(spec.artifact === undefined ? {} : { artifact: spec.artifact }),
                  ...(spec.revisionId === undefined ? {} : { revisionId: spec.revisionId }),
                });
        if (!parsed.ok)
          return localFailure({
            code: 'RESPONSE_INVALID',
            retryable: false,
            reason: parsed.reason,
          });
        if (!parsed.value.ok) {
          const error = parsed.value.error;
          this.#logger.log({
            route: spec.routeTemplate,
            attempt,
            durationMs: performance.now() - startedAt,
            requestId: spec.requestId,
            resultCode: error.code,
          });
          if (shouldRetryError(error) && attempt < maximumAttempts) {
            const serverDelay = retryDelayFromError(error);
            const delay = serverDelay ?? protectedRetryDelayMsV1(attempt);
            if (await sleepWithinDeadlineV1(delay, deadline.remainingMs, deadline.signal)) continue;
          }
          return { ok: false, error: error as BoardErrorV1 };
        }
        this.#logger.log({
          route: spec.routeTemplate,
          attempt,
          durationMs: performance.now() - startedAt,
          requestId: spec.requestId,
          resultCode: spec.resultType,
        });
        return {
          ok: true,
          result: parsed.value.value.result as ResultEnvelopeFor<K>,
          metadata: parsed.value.value.metadata,
        };
      }
      return localFailure({ code: 'TRANSPORT_ERROR', retryable: true, phase: 'request' });
    } finally {
      deadline.dispose();
    }
  }
}
