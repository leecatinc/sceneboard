'use client';

import {
  BOARD_LIMITS_V1,
  BoardErrorParserV1,
  BoardIdParserV1,
  type BoardErrorV1,
} from '@leecat-board/board-schema';
import type {
  BoardStreamDispatchPortV1,
  BoardStreamDispatchResultV1,
  BoardStreamOpenInputV1,
} from '@leecat-board/board-sdk/sse';
import { BoardSdkHttpClient } from '@leecat-board/board-sdk/http';

import {
  parseAnonymousCsrfSnapshot,
  parseAuthSessionSnapshot,
  parsePublicApiError,
  type AuthSessionSnapshot,
} from '../api/auth-contracts';

const LOCK_NAME = 'leecat-board:session-cookie:v1';
const GENERATION_KEY = 'leecat-board:auth-session-generation:v1';
const CHANNEL_NAME = 'leecat-board:auth-session:v1';
const GENERATION_PATTERN = /^[A-Za-z0-9_-]{22}$/;
const UNKNOWN_PATTERN = /^unknown\.[A-Za-z0-9_-]{22}$/;

type LeaseMode = 'shared' | 'exclusive';
type LeaseKind = 'application' | 'reconciliation';
type LeasePhase = 'admitted' | 'intent_published' | 'committed' | 'invalid';

interface SessionCookieLease {
  readonly mode: LeaseMode;
  readonly kind: LeaseKind;
  phase: LeasePhase;
  expectedGeneration: string | null;
  active: boolean;
}

export interface LockManagerPort {
  request<T>(
    name: string,
    options: { mode: 'shared' | 'exclusive' },
    callback: () => Promise<T>,
  ): Promise<T>;
}

export interface GenerationStoragePort {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface SessionCoordinatorDependencies {
  locks: LockManagerPort;
  storage: GenerationStoragePort;
  fetcher: typeof fetch;
  randomBytes(length: number): Uint8Array;
  notify?(): void;
}

export type CoordinatorResult<Value> =
  | { kind: 'ok'; value: Value }
  | { kind: 'reconciliation_required' }
  | { kind: 'unsupported_browser' };

export interface SharedCookieRequest {
  path: string;
  method: 'GET' | 'POST' | 'DELETE';
  body?: unknown;
  csrfToken?: string;
  signal?: AbortSignal;
  responseKind?: 'json' | 'artifact-package' | 'artifact-network';
}

export interface ConsumedResponse {
  response: Response;
  body: unknown;
  bytes: Uint8Array;
}

export class SessionRequestCoordinator implements BoardStreamDispatchPortV1 {
  private observedGeneration: string | null = null;
  private snapshot: AuthSessionSnapshot | null = null;
  private supported: boolean | null = null;
  private renewal: Promise<CoordinatorResult<AuthSessionSnapshot>> | null = null;

  constructor(
    private readonly apiOrigin: string,
    private readonly dependencies: SessionCoordinatorDependencies,
  ) {
    if (new URL(apiOrigin).origin !== apiOrigin) throw new TypeError('API URL must be a canonical origin');
  }

  currentSnapshot(): AuthSessionSnapshot | null {
    return this.snapshot;
  }

  async reconcileSessionGeneration(): Promise<CoordinatorResult<AuthSessionSnapshot | null>> {
    if (!this.ensureSupported()) return { kind: 'unsupported_browser' };
    return this.withLock('exclusive', async () => {
      const lease: SessionCookieLease = {
        mode: 'exclusive',
        kind: 'reconciliation',
        phase: 'admitted',
        expectedGeneration: this.readAuthoritativeGeneration(),
        active: true,
      };
      try {
        const consumed = await this.fetchExclusive(lease, 'session', undefined);
        if (consumed.response.status === 200) {
          return { kind: 'ok', value: this.commitSession(lease, consumed) };
        }
        if (consumed.response.status === 401 && this.commitCleared(lease, consumed)) {
          return { kind: 'ok', value: null };
        }
        this.invalidate(lease);
        return { kind: 'reconciliation_required' };
      } catch {
        this.invalidate(lease);
        return { kind: 'reconciliation_required' };
      } finally {
        lease.active = false;
      }
    });
  }

  async authenticate(
    kind: 'signup' | 'login',
    credentials: { email: string; password: string; verificationTicket?: string },
  ): Promise<CoordinatorResult<AuthSessionSnapshot>
    | { kind: 'session_present' }
    | { kind: 'invalid_credentials' }
    | { kind: 'email_in_use' }
    | { kind: 'verification_required' }> {
    if (!this.ensureSupported()) return { kind: 'unsupported_browser' };
    return this.withApplicationLease('exclusive', async (lease) => {
      const preflight = await this.fetchExclusive(lease, 'session', undefined);
      if (preflight.response.status === 200) {
        this.commitSession(lease, preflight);
        return { kind: 'session_present' as const };
      }
      if (preflight.response.status !== 401 || !this.commitCleared(lease, preflight)) {
        this.invalidate(lease);
        return { kind: 'reconciliation_required' as const };
      }
      const csrfResponse = await this.fetchExclusive(lease, 'csrf', undefined);
      if (csrfResponse.response.status !== 200) {
        this.invalidate(lease);
        return { kind: 'reconciliation_required' as const };
      }
      const csrf = parseAnonymousCsrfSnapshot(csrfResponse.body);
      this.commitGeneration(lease, csrfResponse, null);
      const submitted = await this.fetchExclusive(lease, kind, { credentials, csrfToken: csrf.csrfToken });
      if (submitted.response.status === (kind === 'signup' ? 201 : 200)) {
        return { kind: 'ok' as const, value: this.commitSession(lease, submitted) };
      }
      this.invalidate(lease);
      if (submitted.response.status === 403 || submitted.response.status === 409) {
        try {
          const error = parsePublicApiError(submitted.body);
          if (error.error.code === 'AUTH_EMAIL_IN_USE') return { kind: 'email_in_use' as const };
          if (error.error.code === 'AUTH_EMAIL_VERIFICATION_REQUIRED') return { kind: 'verification_required' as const };
        } catch {
          return { kind: 'reconciliation_required' as const };
        }
      }
      if (
        submitted.response.status === 400
        || submitted.response.status === 401
        || submitted.response.status === 409
        || submitted.response.status === 422
      ) {
        return { kind: 'invalid_credentials' as const };
      }
      return { kind: 'reconciliation_required' as const };
    }).catch(() => ({ kind: 'reconciliation_required' as const }));
  }

  renewSession(): Promise<CoordinatorResult<AuthSessionSnapshot>> {
    if (this.renewal !== null) return this.renewal;
    const capturedSessionId = this.snapshot?.session.sessionId ?? null;
    this.renewal = this.renewWithinOneLease(capturedSessionId)
      .catch(() => ({ kind: 'reconciliation_required' as const }))
      .finally(() => {
        this.renewal = null;
      });
    return this.renewal;
  }

  async logout(): Promise<CoordinatorResult<null>> {
    if (!this.ensureSupported()) return { kind: 'unsupported_browser' };
    return this.withApplicationLease('exclusive', async (lease) => {
      const csrfToken = this.snapshot?.csrfToken;
      const response = await this.fetchExclusive(
        lease,
        'logout',
        csrfToken === undefined ? {} : { csrfToken },
      );
      if (response.response.status === 204 && this.commitEmptyCleared(lease, response)) {
        return { kind: 'ok' as const, value: null };
      }
      this.invalidate(lease);
      return { kind: 'reconciliation_required' as const };
    }).catch(() => ({ kind: 'reconciliation_required' as const }));
  }

  async dispatchShared(request: SharedCookieRequest): Promise<CoordinatorResult<ConsumedResponse>> {
    if (!this.ensureSupported()) return { kind: 'unsupported_browser' };
    return this.withApplicationLease('shared', async () => {
      const headers = new Headers();
      if (request.body !== undefined) headers.set('Content-Type', 'application/json');
      if (request.csrfToken !== undefined) headers.set('X-CSRF-Token', request.csrfToken);
      const response = await this.dependencies.fetcher(`${this.apiOrigin}${request.path}`, {
        method: request.method,
        credentials: 'include',
        headers,
        ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });
      const consumed = await consume(response, request.signal, request.responseKind);
      if (response.status === 401 || response.status === 503) return { kind: 'reconciliation_required' as const };
      return { kind: 'ok' as const, value: consumed };
    }).catch(() => ({ kind: 'reconciliation_required' as const }));
  }

  open<T>(
    input: BoardStreamOpenInputV1,
    consumeOkResponse: (response: Response, heldSignal: AbortSignal) => Promise<T>,
  ): Promise<BoardStreamDispatchResultV1<T>> {
    return this.withBoardStream(input, consumeOkResponse);
  }

  async withBoardStream<T>(
    input: BoardStreamOpenInputV1,
    consumeOkResponse: (response: Response, heldSignal: AbortSignal) => Promise<T>,
  ): Promise<BoardStreamDispatchResultV1<T>> {
    validateBoardStreamInput(input, this.apiOrigin);
    if (!this.ensureSupported()) return { kind: 'protocol_error', sourceStatus: null, error: null };
    const result = await this.withApplicationLease('shared', async (lease) => {
      const acquisitionGeneration = lease.expectedGeneration;
      if (acquisitionGeneration === null || !GENERATION_PATTERN.test(acquisitionGeneration)) {
        return { kind: 'protocol_error' as const, sourceStatus: null, error: null };
      }
      const headers = new Headers({ Accept: 'text/event-stream' });
      if (input.cursor !== null) headers.set('Last-Event-ID', input.cursor);
      const query = new URLSearchParams({ tabId: input.tabId, presenceState: input.presenceState });
      const response = await this.dependencies.fetcher(
        `${this.apiOrigin}/api/v1/boards/${encodeURIComponent(input.boardId)}/events?${query.toString()}`,
        { method: 'GET', credentials: 'include', headers, signal: input.signal },
      );
      if (response.status === 200) {
        if (response.headers.get('content-type')?.toLowerCase() !== 'text/event-stream; charset=utf-8'
          || !hasNoStore(response.headers.get('cache-control'))
          || response.headers.has('set-cookie')) {
          await response.body?.cancel().catch(() => undefined);
          return { kind: 'protocol_error' as const, sourceStatus: 200, error: null };
        }
        return {
          kind: 'stream_ready' as const,
          response,
        };
      }
      const error = await readBoardStreamError(response);
      if (error === null || error.httpStatusHint !== response.status) {
        return { kind: 'protocol_error' as const, sourceStatus: response.status, error };
      }
      const retryAfterMs = retryAfterMilliseconds(response, error);
      if ((response.status === 401 && error.code === 'UNAUTHENTICATED')
        || (response.status === 503 && error.code === 'SERVICE_UNAVAILABLE')) {
        return {
          kind: 'reconciliation_required' as const,
          sourceStatus: response.status,
          error,
          acquisitionGeneration,
          retryAfterMs,
        };
      }
      if ((response.status === 400 && error.code === 'INVALID_PAYLOAD')
        || (response.status === 403 && error.code === 'FORBIDDEN')
        || (response.status === 404 && error.code === 'BOARD_NOT_FOUND')
        || (response.status === 429 && error.code === 'RATE_LIMITED')
        || (response.status === 500 && error.code === 'INTERNAL_ERROR')) {
        return {
          kind: 'http_error' as const,
          sourceStatus: response.status,
          error,
          retryAfterMs,
        } as BoardStreamDispatchResultV1<T>;
      }
      return { kind: 'protocol_error' as const, sourceStatus: response.status, error };
    });
    if (result.kind === 'stream_ready') {
      return {
        kind: 'consumed',
        value: await consumeOkResponse(result.response, input.signal),
      };
    }
    if (result.kind === 'unsupported_browser' || result.kind === 'ok') {
      return { kind: 'protocol_error', sourceStatus: null, error: null };
    }
    if (result.kind === 'reconciliation_required') {
      if (!Object.hasOwn(result, 'sourceStatus')) return { kind: 'protocol_error', sourceStatus: null, error: null };
      return result as BoardStreamDispatchResultV1<T>;
    }
    return result;
  }

  private async renewWithinOneLease(capturedSessionId: string | null): Promise<CoordinatorResult<AuthSessionSnapshot>> {
    if (!this.ensureSupported()) return { kind: 'unsupported_browser' };
    return this.withApplicationLease('exclusive', async (lease) => {
      const preflight = await this.fetchExclusive(lease, 'session', undefined);
      if (preflight.response.status !== 200) {
        if (preflight.response.status === 401) this.commitCleared(lease, preflight);
        else this.invalidate(lease);
        return { kind: 'reconciliation_required' as const };
      }
      const active = this.commitSession(lease, preflight);
      if (capturedSessionId === null || active.session.sessionId !== capturedSessionId) {
        return { kind: 'ok' as const, value: active };
      }
      const renewed = await this.fetchExclusive(lease, 'renew', { csrfToken: active.csrfToken });
      if (renewed.response.status !== 200) {
        this.invalidate(lease);
        return { kind: 'reconciliation_required' as const };
      }
      return { kind: 'ok' as const, value: this.commitSession(lease, renewed) };
    });
  }

  private async withApplicationLease<T>(
    mode: LeaseMode,
    operation: (lease: SessionCookieLease) => Promise<T>,
  ): Promise<T | CoordinatorResult<never>> {
    return this.withLock(mode, async () => {
      const authoritative = this.readAuthoritativeGeneration();
      if (!isCommittedGeneration(authoritative) || authoritative !== this.observedGeneration) {
        return { kind: 'reconciliation_required' };
      }
      const lease: SessionCookieLease = {
        mode,
        kind: 'application',
        phase: 'admitted',
        expectedGeneration: authoritative,
        active: true,
      };
      try {
        return await operation(lease);
      } finally {
        lease.active = false;
      }
    });
  }

  private withLock<T>(mode: LeaseMode, operation: () => Promise<T>): Promise<T> {
    return this.dependencies.locks.request(LOCK_NAME, { mode }, operation);
  }

  private async fetchExclusive(
    lease: SessionCookieLease,
    kind: 'session' | 'csrf' | 'signup' | 'login' | 'renew' | 'logout',
    input: {
      credentials?: { email: string; password: string; verificationTicket?: string };
      csrfToken?: string;
    } | undefined,
  ): Promise<ConsumedResponse> {
    if (!lease.active || lease.mode !== 'exclusive' || !['admitted', 'committed'].includes(lease.phase)) {
      throw new TypeError('invalid exclusive session lease');
    }
    if (lease.kind === 'reconciliation' && kind !== 'session') throw new TypeError('reconciliation can only probe the session');
    if (lease.kind === 'application' && this.readAuthoritativeGeneration() !== lease.expectedGeneration) {
      throw new TypeError('session generation changed before dispatch');
    }
    const unknown = `unknown.${randomMarker(this.dependencies.randomBytes)}`;
    this.writeGeneration(unknown);
    this.observedGeneration = null;
    this.snapshot = null;
    lease.phase = 'intent_published';
    const request = closedRequest(kind, input);
    const response = await this.dependencies.fetcher(`${this.apiOrigin}${request.path}`, {
      method: request.method,
      credentials: 'include',
      headers: request.headers,
      ...(request.body === undefined ? {} : { body: request.body }),
    });
    return consume(response);
  }

  private commitSession(lease: SessionCookieLease, consumed: ConsumedResponse): AuthSessionSnapshot {
    const snapshot = parseAuthSessionSnapshot(consumed.body);
    this.commitGeneration(lease, consumed, snapshot);
    return snapshot;
  }

  private commitCleared(lease: SessionCookieLease, consumed: ConsumedResponse): boolean {
    try {
      parsePublicApiError(consumed.body);
    } catch {
      return false;
    }
    return this.commitClearedGeneration(lease, consumed);
  }

  private commitEmptyCleared(lease: SessionCookieLease, consumed: ConsumedResponse): boolean {
    if (consumed.body !== null || consumed.bytes.byteLength !== 0) return false;
    return this.commitClearedGeneration(lease, consumed);
  }

  private commitClearedGeneration(lease: SessionCookieLease, consumed: ConsumedResponse): boolean {
    if (consumed.response.headers.get('X-Auth-Generation') !== 'cleared') return false;
    this.snapshot = null;
    this.writeGeneration('cleared');
    this.observedGeneration = 'cleared';
    lease.expectedGeneration = 'cleared';
    lease.phase = 'committed';
    return true;
  }

  private commitGeneration(
    lease: SessionCookieLease,
    consumed: ConsumedResponse,
    snapshot: AuthSessionSnapshot | null,
  ): void {
    const generation = consumed.response.headers.get('X-Auth-Generation');
    if (generation === null || !GENERATION_PATTERN.test(generation)) throw new TypeError('missing auth generation proof');
    this.snapshot = snapshot;
    this.writeGeneration(generation);
    this.observedGeneration = generation;
    lease.expectedGeneration = generation;
    lease.phase = 'committed';
  }

  private invalidate(lease: SessionCookieLease): void {
    lease.phase = 'invalid';
    this.snapshot = null;
    this.observedGeneration = null;
  }

  private ensureSupported(): boolean {
    if (this.supported !== null) return this.supported;
    try {
      const prior = this.dependencies.storage.getItem(GENERATION_KEY);
      const probe = `unknown.${randomMarker(this.dependencies.randomBytes)}`;
      this.dependencies.storage.setItem(GENERATION_KEY, probe);
      if (this.dependencies.storage.getItem(GENERATION_KEY) !== probe) throw new TypeError('generation storage is unreliable');
      if (prior === null) this.dependencies.storage.removeItem(GENERATION_KEY);
      else this.dependencies.storage.setItem(GENERATION_KEY, prior);
      this.observedGeneration = isCommittedGeneration(prior) ? prior : null;
      this.supported = true;
    } catch {
      this.supported = false;
    }
    return this.supported;
  }

  private readAuthoritativeGeneration(): string | null {
    try {
      return this.dependencies.storage.getItem(GENERATION_KEY);
    } catch {
      this.supported = false;
      return null;
    }
  }

  private writeGeneration(value: string): void {
    this.dependencies.storage.setItem(GENERATION_KEY, value);
    if (this.dependencies.storage.getItem(GENERATION_KEY) !== value) throw new TypeError('generation storage write failed');
    this.dependencies.notify?.();
  }
}

const STREAM_TAB_ID = /^[A-Za-z0-9_-]{22}$/;
const STREAM_CURSOR = /^[\x21-\x7e]{1,512}$/;
const MAX_STREAM_ERROR_BYTES = 65_536;

const validateBoardStreamInput = (input: BoardStreamOpenInputV1, apiOrigin: string): void => {
  if (input.apiOrigin !== apiOrigin) throw new TypeError('board stream origin does not match the coordinator');
  if (!BoardIdParserV1.parse(input.boardId).ok) throw new TypeError('board stream board ID is invalid');
  if (!STREAM_TAB_ID.test(input.tabId)) throw new TypeError('board stream tab ID is invalid');
  if (input.presenceState !== 'online' && input.presenceState !== 'away') {
    throw new TypeError('board stream presence state is invalid');
  }
  if (input.cursor !== null && !STREAM_CURSOR.test(input.cursor)) throw new TypeError('board stream cursor is invalid');
  if (typeof input.signal !== 'object' || input.signal === null || typeof input.signal.aborted !== 'boolean') {
    throw new TypeError('board stream signal is invalid');
  }
};

const hasNoStore = (value: string | null): boolean => value !== null && value
  .split(',')
  .map((part) => part.trim().toLowerCase())
  .includes('no-store');

const readBoardStreamError = async (response: Response): Promise<BoardErrorV1 | null> => {
  if (!hasNoStore(response.headers.get('cache-control')) || response.body === null) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MAX_STREAM_ERROR_BYTES) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(next.value);
    }
  } catch {
    return null;
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return null;
  }
  if (decoded === null || typeof decoded !== 'object' || Array.isArray(decoded)
    || Object.keys(decoded).length !== 1 || !Object.hasOwn(decoded, 'error')) return null;
  const parsed = BoardErrorParserV1.parse((decoded as { error: unknown }).error);
  return parsed.ok ? parsed.data.value : null;
};

const retryAfterMilliseconds = (response: Response, error: BoardErrorV1): number | null => {
  const source = response.headers.get('retry-after');
  if (source === null) return null;
  if (!/^(?:[1-9]|[1-5][0-9]|60)$/.test(source)) return null;
  const seconds = Number(source);
  if (error.code === 'RATE_LIMITED' && error.details.retryAfterSeconds !== seconds) return null;
  return seconds * 1_000;
};

const isCommittedGeneration = (value: string | null): value is string => (
  value === 'cleared' || value !== null && GENERATION_PATTERN.test(value)
);

const randomMarker = (randomBytes: (length: number) => Uint8Array): string => {
  const bytes = randomBytes(16);
  if (bytes.byteLength !== 16) throw new TypeError('generation nonce must be 16 bytes');
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const encoded = btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  if (!GENERATION_PATTERN.test(encoded)) throw new TypeError('generation nonce is invalid');
  return encoded;
};

const closedRequest = (
  kind: 'session' | 'csrf' | 'signup' | 'login' | 'renew' | 'logout',
  input: {
    credentials?: { email: string; password: string; verificationTicket?: string };
    csrfToken?: string;
  } | undefined,
): { path: string; method: 'GET' | 'POST'; headers: Headers; body?: string } => {
  const headers = new Headers();
  if (kind === 'session') return { path: '/api/v1/auth/session', method: 'GET', headers };
  if (kind === 'csrf') return { path: '/api/v1/auth/csrf', method: 'GET', headers };
  headers.set('Content-Type', 'application/json');
  if (input?.csrfToken !== undefined) headers.set('X-CSRF-Token', input.csrfToken);
  if (kind === 'signup' || kind === 'login') {
    if (input?.credentials === undefined || input.csrfToken === undefined) throw new TypeError('auth input is incomplete');
    return { path: `/api/v1/auth/${kind}`, method: 'POST', headers, body: JSON.stringify(input.credentials) };
  }
  return {
    path: kind === 'renew' ? '/api/v1/auth/session/renew' : '/api/v1/auth/logout',
    method: 'POST',
    headers,
    body: '{}',
  };
};

const consume = async (
  response: Response,
  signal: AbortSignal = new AbortController().signal,
  responseKind: SharedCookieRequest['responseKind'] = 'json',
): Promise<ConsumedResponse> => {
  const maximumBytes = responseKind === 'artifact-package'
    ? BOARD_LIMITS_V1.maxArtifactTotalBytes + 262_144
    : responseKind === 'artifact-network'
      ? 1_048_640
      : 2_097_152;
  const read = response.status === 204 && response.body === null
    ? new Uint8Array()
    : await BoardSdkHttpClient.readBoundedResponseBodyV1(response, maximumBytes, signal);
  if (typeof read === 'string') throw new TypeError('response body could not be consumed safely');
  const bytes = read;
  if (response.status === 204) return { response, body: null, bytes };
  if (responseKind !== 'json' && response.ok) return { response, body: null, bytes };
  const body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
  return { response, body, bytes };
};

export const browserSessionCoordinator = (apiOrigin: string): SessionRequestCoordinator => {
  if (!('locks' in navigator) || navigator.locks === undefined) throw new TypeError('Web Locks are required');
  const locks = navigator.locks;
  const storage = localStorage;
  const channel = new BroadcastChannel(CHANNEL_NAME);
  return new SessionRequestCoordinator(apiOrigin, {
    locks: {
      async request<T>(name: string, options: { mode: 'shared' | 'exclusive' }, callback: () => Promise<T>): Promise<T> {
        return await locks.request(name, options, async () => await callback());
      },
    },
    storage: {
      getItem: (key) => storage.getItem(key),
      setItem: (key, value) => storage.setItem(key, value),
      removeItem: (key) => storage.removeItem(key),
    },
    fetcher: (...arguments_) => fetch(...arguments_),
    randomBytes: (length) => crypto.getRandomValues(new Uint8Array(length)),
    notify: () => channel.postMessage({ type: 'generation-changed' }),
  });
};

export const sessionCoordinationConstants = Object.freeze({ LOCK_NAME, GENERATION_KEY, CHANNEL_NAME, UNKNOWN_PATTERN });
