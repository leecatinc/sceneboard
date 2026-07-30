'use client';

import type { AccountApiKeyScopeV1 } from '@sceneboard/board-schema';

import type { SessionRequestCoordinator } from '../auth/renewal-singleflight';
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

const scopes = new Set<AccountApiKeyScopeV1>([
  'board:archive',
  'board:create',
  'board:read',
  'board:write',
  'export:read',
  'history:read',
]);
const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
const metadata = (value: unknown): AccountApiKeyMetadata | null => {
  const item = record(value);
  if (
    item === null ||
    Object.keys(item).join(',') !==
      'apiKeyId,name,prefix,scopes,status,createdAt,expiresAt,lastUsedAt' ||
    typeof item.apiKeyId !== 'string' ||
    typeof item.name !== 'string' ||
    typeof item.prefix !== 'string' ||
    !Array.isArray(item.scopes) ||
    item.scopes.some((scope) => !scopes.has(scope as AccountApiKeyScopeV1)) ||
    !['active', 'expired', 'revoked'].includes(String(item.status)) ||
    typeof item.createdAt !== 'string' ||
    typeof item.expiresAt !== 'string' ||
    (item.lastUsedAt !== null && typeof item.lastUsedAt !== 'string')
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

  async list(signal?: AbortSignal): Promise<ApiResult<AccountApiKeyMetadata[]>> {
    const result = await this.request(
      '/api/v1/account/api-keys?limit=20',
      'GET',
      undefined,
      signal,
    );
    if (result.kind !== 'ok') return result;
    const body = record(result.value);
    if (
      body === null ||
      Object.keys(body).join(',') !== 'items,nextCursor' ||
      !Array.isArray(body.items) ||
      (body.nextCursor !== null && typeof body.nextCursor !== 'string')
    )
      return { kind: 'corrupt_response' };
    const items = body.items.map(metadata);
    return items.some((item) => item === null)
      ? { kind: 'corrupt_response' }
      : { kind: 'ok', value: items as AccountApiKeyMetadata[] };
  }

  async create(
    input: { displayName: string; scopes: AccountApiKeyScopeV1[]; expiresAt: string },
    signal?: AbortSignal,
  ): Promise<ApiResult<{ apiKey: string; metadata: AccountApiKeyMetadata }>> {
    const result = await this.request('/api/v1/account/api-keys', 'POST', input, signal);
    if (result.kind !== 'ok') return result;
    const body = record(result.value);
    const parsed = metadata(body?.metadata);
    return body !== null &&
      Object.keys(body).join(',') === 'apiKey,metadata' &&
      typeof body.apiKey === 'string' &&
      /^sbk_v1\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/u.test(body.apiKey) &&
      parsed !== null
      ? { kind: 'ok', value: { apiKey: body.apiKey, metadata: parsed } }
      : { kind: 'corrupt_response' };
  }

  async revoke(apiKeyId: string, signal?: AbortSignal): Promise<ApiResult<null>> {
    const result = await this.request(
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

  private async request(
    path: string,
    method: 'GET' | 'POST' | 'DELETE',
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<ApiResult<unknown>> {
    const csrfToken = this.coordinator.currentSnapshot()?.csrfToken;
    if (csrfToken === undefined) return { kind: 'reconciliation_required' };
    const dispatched = await this.coordinator.dispatchShared({
      path,
      method,
      csrfToken,
      ...(body === undefined ? {} : { body }),
      ...(signal === undefined ? {} : { signal }),
    });
    if (dispatched.kind !== 'ok') return dispatched;
    if (!dispatched.value.response.ok)
      return { kind: 'api_error', status: dispatched.value.response.status };
    if (method === 'DELETE')
      return dispatched.value.response.status === 204
        ? { kind: 'ok', value: null }
        : { kind: 'corrupt_response' };
    return { kind: 'ok', value: dispatched.value.body };
  }
}
