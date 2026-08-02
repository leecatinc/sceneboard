'use client';

import { ACCOUNT_API_KEY_SCOPES_V1, type AccountApiKeyScopeV1 } from '@sceneboard/board-schema';

import type {
  CoordinatorResult,
  CurrentGenerationBindingV1,
  SessionRequestCoordinator,
} from '../auth/renewal-singleflight';
import type { ApiResult } from './board-api-types';

export type AccountApiKeyMetadata = {
  apiKeyId: string;
  name: string;
  prefix: string;
  scopes: AccountApiKeyScopeV1[];
  status: 'active' | 'expired' | 'revoked';
  createdAt: string;
  expiresAt: string;
  lastUsedAt: string | null;
};

export type AccountApiKeyPage = {
  items: AccountApiKeyMetadata[];
  nextCursor: string | null;
};

export type CreatedAccountApiKey = {
  apiKey: string;
  metadata: AccountApiKeyMetadata;
  generationBinding: CurrentGenerationBindingV1;
};

type AccountApiKeyRequestKind = 'list' | 'mutation';

type OwnedRequest = {
  controller: AbortController;
  settle: () => void;
};

export class AccountApiKeyRequestOwnership {
  private readonly requests = new Map<AccountApiKeyRequestKind, OwnedRequest>();

  begin(kind: AccountApiKeyRequestKind, settle: () => void): AbortController {
    this.abort(kind);
    const controller = new AbortController();
    this.requests.set(kind, { controller, settle });
    return controller;
  }

  isCurrent(kind: AccountApiKeyRequestKind, controller: AbortController): boolean {
    return this.requests.get(kind)?.controller === controller && !controller.signal.aborted;
  }

  finish(kind: AccountApiKeyRequestKind, controller: AbortController): boolean {
    if (!this.isCurrent(kind, controller)) return false;
    this.requests.delete(kind);
    return true;
  }

  abort(kind: AccountApiKeyRequestKind): void {
    const request = this.requests.get(kind);
    if (request === undefined) return;
    this.requests.delete(kind);
    request.controller.abort();
    request.settle();
  }

  abortAll(): void {
    this.abort('list');
    this.abort('mutation');
  }
}

type StaleRecoveryCallbacks = {
  scrub: () => void;
  reconcile: () => Promise<CoordinatorResult<unknown | null>>;
  onSignedOut: () => void;
  onActive: () => void;
  onFailed: () => void;
};

export class AccountApiKeyStaleRecovery {
  private active: Promise<void> | null = null;

  recover(callbacks: StaleRecoveryCallbacks): Promise<void> {
    callbacks.scrub();
    if (this.active !== null) return this.active;
    const recovery = (async () => {
      try {
        const result = await callbacks.reconcile();
        if (result.kind !== 'ok') callbacks.onFailed();
        else if (result.value === null) callbacks.onSignedOut();
        else callbacks.onActive();
      } catch {
        try {
          callbacks.onFailed();
        } catch {
          // Recovery callbacks must never turn a stale session into an unhandled rejection.
        }
      }
    })();
    this.active = recovery;
    void recovery.finally(() => {
      if (this.active === recovery) this.active = null;
    });
    return recovery;
  }
}

const scopeOrder = new Map<string, number>(
  ACCOUNT_API_KEY_SCOPES_V1.map((scope, index) => [scope, index]),
);
const expiryDays = new Set([30, 90, 365]);
const apiKeyIdPattern = /^[A-Za-z0-9_-]{1,128}$/u;
const apiKeyPrefixPattern = /^sbk_v1\.[A-Za-z0-9_-]{8}…$/u;
const cursorPattern = /^[A-Za-z0-9_-]{1,512}$/u;
const timestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
const hasExactOwnKeys = (value: Record<string, unknown>, expected: readonly string[]): boolean => {
  const keys = Object.keys(value);
  return (
    keys.length === expected.length &&
    expected.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  );
};
const metadataKeys = [
  'apiKeyId',
  'name',
  'prefix',
  'scopes',
  'status',
  'createdAt',
  'expiresAt',
  'lastUsedAt',
] as const;
const canonicalTimestamp = (value: unknown): value is string => {
  if (typeof value !== 'string' || !timestampPattern.test(value)) return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
};
const canonicalScopes = (value: unknown): value is AccountApiKeyScopeV1[] =>
  Array.isArray(value) &&
  value.length > 0 &&
  value.every((scope, index) => {
    if (typeof scope !== 'string') return false;
    const position = scopeOrder.get(scope);
    if (position === undefined) return false;
    if (index === 0) return true;
    const previous = value[index - 1];
    return typeof previous === 'string' && (scopeOrder.get(previous) ?? -1) < position;
  });
const metadata = (value: unknown): AccountApiKeyMetadata | null => {
  const item = record(value);
  if (
    item === null ||
    !hasExactOwnKeys(item, metadataKeys) ||
    typeof item.apiKeyId !== 'string' ||
    !apiKeyIdPattern.test(item.apiKeyId) ||
    typeof item.name !== 'string' ||
    item.name !== item.name.trim() ||
    [...item.name].length < 1 ||
    [...item.name].length > 80 ||
    typeof item.prefix !== 'string' ||
    !apiKeyPrefixPattern.test(item.prefix) ||
    !canonicalScopes(item.scopes) ||
    !['active', 'expired', 'revoked'].includes(String(item.status)) ||
    !canonicalTimestamp(item.createdAt) ||
    !canonicalTimestamp(item.expiresAt) ||
    Date.parse(item.createdAt) >= Date.parse(item.expiresAt) ||
    (item.lastUsedAt !== null &&
      (!canonicalTimestamp(item.lastUsedAt) ||
        Date.parse(item.lastUsedAt) < Date.parse(item.createdAt)))
  )
    return null;
  return {
    apiKeyId: item.apiKeyId,
    name: item.name,
    prefix: item.prefix,
    scopes: item.scopes as AccountApiKeyScopeV1[],
    status: item.status as AccountApiKeyMetadata['status'],
    createdAt: item.createdAt,
    expiresAt: item.expiresAt,
    lastUsedAt: item.lastUsedAt,
  };
};

export class AccountApiKeyApi {
  constructor(private readonly coordinator: SessionRequestCoordinator) {}

  async list(
    binding: CurrentGenerationBindingV1,
    cursor: string | null = null,
    signal?: AbortSignal,
  ): Promise<ApiResult<AccountApiKeyPage> | { kind: 'stale_attempt' }> {
    const path = `/api/v1/account/api-keys?limit=20${
      cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`
    }`;
    const result = await this.requestForGeneration(binding, path, 'GET', undefined, signal);
    if (result.kind !== 'ok') return result;
    const body = record(result.value);
    if (
      body === null ||
      !hasExactOwnKeys(body, ['items', 'nextCursor']) ||
      !Array.isArray(body.items) ||
      body.items.length > 20 ||
      (body.nextCursor !== null &&
        (typeof body.nextCursor !== 'string' || !cursorPattern.test(body.nextCursor)))
    )
      return { kind: 'corrupt_response' };
    const items = body.items.map(metadata);
    const ids = new Set(items.map((item) => item?.apiKeyId));
    return items.some((item) => item === null) || ids.size !== items.length
      ? { kind: 'corrupt_response' }
      : {
          kind: 'ok',
          value: {
            items: items as AccountApiKeyMetadata[],
            nextCursor: body.nextCursor as string | null,
          },
        };
  }

  async create(
    input: { displayName: string; scopes: AccountApiKeyScopeV1[]; expiresInDays: number },
    signal?: AbortSignal,
  ): Promise<
    ApiResult<CreatedAccountApiKey> | { kind: 'stale_attempt' } | { kind: 'invalid_input' }
  > {
    if (!Number.isSafeInteger(input.expiresInDays) || !expiryDays.has(input.expiresInDays)) {
      return { kind: 'invalid_input' };
    }
    if (this.coordinator.currentSnapshot()?.csrfToken === undefined)
      return { kind: 'reconciliation_required' };
    const bound = await this.coordinator.bindCurrentGeneration();
    if (bound.kind !== 'bound') return bound;
    const result = await this.requestForGeneration(
      bound.binding,
      '/api/v1/account/api-keys',
      'POST',
      input,
      signal,
    );
    if (result.kind !== 'ok') return result;
    const body = record(result.value);
    const parsed = metadata(body?.metadata);
    return body !== null &&
      hasExactOwnKeys(body, ['apiKey', 'metadata']) &&
      typeof body.apiKey === 'string' &&
      /^sbk_v1\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/u.test(body.apiKey) &&
      parsed !== null
      ? {
          kind: 'ok',
          value: {
            apiKey: body.apiKey,
            metadata: parsed,
            generationBinding: bound.binding,
          },
        }
      : { kind: 'corrupt_response' };
  }

  async revoke(
    binding: CurrentGenerationBindingV1,
    apiKeyId: string,
    signal?: AbortSignal,
  ): Promise<ApiResult<null> | { kind: 'stale_attempt' }> {
    const result = await this.requestForGeneration(
      binding,
      `/api/v1/account/api-keys/${encodeURIComponent(apiKeyId)}`,
      'DELETE',
      undefined,
      signal,
    );
    return result.kind === 'ok' && result.value === null
      ? { kind: 'ok', value: null }
      : result.kind === 'ok'
        ? { kind: 'corrupt_response' }
        : result;
  }

  private async requestForGeneration(
    binding: CurrentGenerationBindingV1,
    path: string,
    method: 'GET' | 'POST' | 'DELETE',
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<ApiResult<unknown> | { kind: 'stale_attempt' }> {
    const csrfToken = this.coordinator.currentSnapshot()?.csrfToken;
    if (csrfToken === undefined) return { kind: 'stale_attempt' };
    const dispatched = await this.coordinator.dispatchSharedForGeneration(binding, {
      path,
      method,
      ...(body === undefined ? {} : { body }),
      csrfToken,
      ...(signal === undefined ? {} : { signal }),
    });
    if (dispatched.kind === 'stale_attempt') return dispatched;
    if (dispatched.kind !== 'ok') return { kind: 'reconciliation_required' };
    if (!dispatched.value.response.ok)
      return { kind: 'api_error', status: dispatched.value.response.status };
    const expectedStatus = method === 'GET' ? 200 : method === 'POST' ? 201 : 204;
    if (dispatched.value.response.status !== expectedStatus) return { kind: 'corrupt_response' };
    if (method === 'DELETE') {
      return dispatched.value.body === null && dispatched.value.bytes.byteLength === 0
        ? { kind: 'ok', value: null }
        : { kind: 'corrupt_response' };
    }
    return { kind: 'ok', value: dispatched.value.body };
  }
}
