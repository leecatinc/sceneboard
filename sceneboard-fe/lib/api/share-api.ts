'use client';

import {
  BoardIdParserV1,
  GlobalIdStringParserV1,
  ShareErrorEnvelopeParserV1,
  ShareIdempotencyKeyParserV1,
  ShareListResultParserV1,
  SharePasswordReplayResultParserV1,
  SharePasswordSuccessParserV1,
  SharePublishSuccessParserV1,
  ShareRotateSuccessParserV1,
  ShareSecretReplayResultParserV1,
  ShareUpdateSuccessParserV1,
  type ShareErrorV1,
  type ShareListResultV1,
  type ShareManagementViewV1,
  type SharePasswordReplayResultV1,
  type SharePasswordSuccessV1,
  type SharePublishSuccessV1,
  type ShareRotateSuccessV1,
  type ShareSecretReplayResultV1,
  type ShareUpdateSuccessV1,
} from '@sceneboard/board-schema';

import type { CoordinatorResult, SessionRequestCoordinator } from '../auth/renewal-singleflight';
import { exactKeys, isObject } from './board-api-core';

type Parser<Value> = {
  parse(input: unknown): { ok: true; data: { value: Value } } | { ok: false };
};

export type ShareApiResult<Value> =
  | CoordinatorResult<Value>
  | { kind: 'share_error'; error: ShareErrorV1 }
  | { kind: 'api_error'; status: number }
  | { kind: 'corrupt_response' };

export type SharePublishResultV1 = SharePublishSuccessV1 | ShareSecretReplayResultV1;
export type ShareRotateResultV1 = ShareRotateSuccessV1 | ShareSecretReplayResultV1;
export type SharePasswordResultV1 = SharePasswordSuccessV1 | SharePasswordReplayResultV1;

const parse = <Value>(parser: Parser<Value>, value: unknown, label: string): Value => {
  const parsed = parser.parse(value);
  if (!parsed.ok) throw new TypeError(`invalid ${label}`);
  return parsed.data.value;
};

const unionParser = <Left, Right>(
  left: Parser<Left>,
  right: Parser<Right>,
): Parser<Left | Right> => ({
  parse(input) {
    const first = left.parse(input);
    return first.ok ? first : right.parse(input);
  },
});

const publishResultParser = unionParser(
  SharePublishSuccessParserV1,
  ShareSecretReplayResultParserV1,
);
const rotateResultParser = unionParser(ShareRotateSuccessParserV1, ShareSecretReplayResultParserV1);
const passwordResultParser = unionParser(
  SharePasswordSuccessParserV1,
  SharePasswordReplayResultParserV1,
);

export const createShareIdempotencyKeyV1 = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `share_${btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')}`;
};

export class ShareApi {
  constructor(private readonly coordinator: SessionRequestCoordinator) {}

  list(boardIdValue: string, signal?: AbortSignal): Promise<ShareApiResult<ShareListResultV1>> {
    const boardId = parse(BoardIdParserV1, boardIdValue, 'share board ID');
    return this.dispatch(
      `/api/v1/boards/${encodeURIComponent(boardId)}/shares`,
      'GET',
      undefined,
      ShareListResultParserV1,
      [200],
      undefined,
      signal,
    );
  }

  publish(
    boardIdValue: string,
    pinnedRevisionIdValue: string,
    idempotencyKeyValue: string,
    signal?: AbortSignal,
  ): Promise<ShareApiResult<SharePublishResultV1>> {
    const boardId = parse(BoardIdParserV1, boardIdValue, 'share board ID');
    const pinnedRevisionId = parse(
      GlobalIdStringParserV1,
      pinnedRevisionIdValue,
      'share revision ID',
    );
    return this.dispatch(
      `/api/v1/boards/${encodeURIComponent(boardId)}/shares`,
      'POST',
      { pinnedRevisionId },
      publishResultParser,
      [200, 201],
      idempotencyKeyValue,
      signal,
    );
  }

  update(
    boardIdValue: string,
    share: ShareManagementViewV1,
    pinnedRevisionIdValue: string,
    idempotencyKeyValue: string,
    signal?: AbortSignal,
  ): Promise<ShareApiResult<ShareUpdateSuccessV1>> {
    const { boardId, shareId, pinnedRevisionId, idempotencyKey } = this.identities(
      boardIdValue,
      share.shareId,
      pinnedRevisionIdValue,
      idempotencyKeyValue,
    );
    return this.dispatch(
      `/api/v1/boards/${encodeURIComponent(boardId)}/shares/${encodeURIComponent(shareId)}`,
      'PATCH',
      { pinnedRevisionId, expectedVersion: share.version },
      ShareUpdateSuccessParserV1,
      [200],
      idempotencyKey,
      signal,
    );
  }

  rotate(
    boardIdValue: string,
    share: ShareManagementViewV1,
    idempotencyKeyValue: string,
    signal?: AbortSignal,
  ): Promise<ShareApiResult<ShareRotateResultV1>> {
    return this.shareVersionMutation(
      boardIdValue,
      share,
      'POST',
      'rotate-link',
      rotateResultParser,
      [200],
      idempotencyKeyValue,
      signal,
    );
  }

  revoke(
    boardIdValue: string,
    share: ShareManagementViewV1,
    idempotencyKeyValue: string,
    signal?: AbortSignal,
  ): Promise<ShareApiResult<null>> {
    return this.shareVersionMutation(
      boardIdValue,
      share,
      'DELETE',
      '',
      null,
      [204],
      idempotencyKeyValue,
      signal,
    );
  }

  enablePassword(
    boardIdValue: string,
    share: ShareManagementViewV1,
    idempotencyKeyValue: string,
    signal?: AbortSignal,
  ): Promise<ShareApiResult<SharePasswordResultV1>> {
    return this.shareVersionMutation(
      boardIdValue,
      share,
      'POST',
      'password',
      passwordResultParser,
      [200],
      idempotencyKeyValue,
      signal,
    );
  }

  regeneratePassword(
    boardIdValue: string,
    share: ShareManagementViewV1,
    idempotencyKeyValue: string,
    signal?: AbortSignal,
  ): Promise<ShareApiResult<SharePasswordResultV1>> {
    return this.shareVersionMutation(
      boardIdValue,
      share,
      'POST',
      'password/regenerate',
      passwordResultParser,
      [200],
      idempotencyKeyValue,
      signal,
    );
  }

  disablePassword(
    boardIdValue: string,
    share: ShareManagementViewV1,
    idempotencyKeyValue: string,
    signal?: AbortSignal,
  ): Promise<ShareApiResult<null>> {
    return this.shareVersionMutation(
      boardIdValue,
      share,
      'DELETE',
      'password',
      null,
      [204],
      idempotencyKeyValue,
      signal,
    );
  }

  private identities(
    boardIdValue: string,
    shareIdValue: string,
    revisionIdValue: string,
    idempotencyKeyValue: string,
  ) {
    return {
      boardId: parse(BoardIdParserV1, boardIdValue, 'share board ID'),
      shareId: parse(GlobalIdStringParserV1, shareIdValue, 'share ID'),
      pinnedRevisionId: parse(GlobalIdStringParserV1, revisionIdValue, 'share revision ID'),
      idempotencyKey: parse(
        ShareIdempotencyKeyParserV1,
        idempotencyKeyValue,
        'share idempotency key',
      ),
    };
  }

  private shareVersionMutation<Value>(
    boardIdValue: string,
    share: ShareManagementViewV1,
    method: 'POST' | 'DELETE',
    suffix: string,
    parser: Parser<Value>,
    successStatuses: readonly number[],
    idempotencyKeyValue: string,
    signal?: AbortSignal,
  ): Promise<ShareApiResult<Value>>;
  private shareVersionMutation(
    boardIdValue: string,
    share: ShareManagementViewV1,
    method: 'POST' | 'DELETE',
    suffix: string,
    parser: null,
    successStatuses: readonly number[],
    idempotencyKeyValue: string,
    signal?: AbortSignal,
  ): Promise<ShareApiResult<null>>;
  private shareVersionMutation<Value>(
    boardIdValue: string,
    share: ShareManagementViewV1,
    method: 'POST' | 'DELETE',
    suffix: string,
    parser: Parser<Value> | null,
    successStatuses: readonly number[],
    idempotencyKeyValue: string,
    signal?: AbortSignal,
  ): Promise<ShareApiResult<Value | null>> {
    const boardId = parse(BoardIdParserV1, boardIdValue, 'share board ID');
    const shareId = parse(GlobalIdStringParserV1, share.shareId, 'share ID');
    const idempotencyKey = parse(
      ShareIdempotencyKeyParserV1,
      idempotencyKeyValue,
      'share idempotency key',
    );
    const tail = suffix === '' ? '' : `/${suffix}`;
    if (parser === null) {
      return this.dispatch(
        `/api/v1/boards/${encodeURIComponent(boardId)}/shares/${encodeURIComponent(shareId)}${tail}`,
        method,
        { expectedVersion: share.version },
        null,
        successStatuses,
        idempotencyKey,
        signal,
      );
    }
    return this.dispatch(
      `/api/v1/boards/${encodeURIComponent(boardId)}/shares/${encodeURIComponent(shareId)}${tail}`,
      method,
      { expectedVersion: share.version },
      parser,
      successStatuses,
      idempotencyKey,
      signal,
    );
  }

  private dispatch<Value>(
    path: string,
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    body: unknown,
    parser: Parser<Value>,
    successStatuses: readonly number[],
    idempotencyKeyValue?: string,
    signal?: AbortSignal,
  ): Promise<ShareApiResult<Value>>;
  private dispatch(
    path: string,
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    body: unknown,
    parser: null,
    successStatuses: readonly number[],
    idempotencyKeyValue?: string,
    signal?: AbortSignal,
  ): Promise<ShareApiResult<null>>;
  private async dispatch<Value>(
    path: string,
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    body: unknown,
    parser: Parser<Value> | null,
    successStatuses: readonly number[],
    idempotencyKeyValue?: string,
    signal?: AbortSignal,
  ): Promise<ShareApiResult<Value | null>> {
    const csrfToken = method === 'GET' ? undefined : this.coordinator.currentSnapshot()?.csrfToken;
    if (method !== 'GET' && csrfToken === undefined) return { kind: 'reconciliation_required' };
    const idempotencyKey =
      idempotencyKeyValue === undefined
        ? undefined
        : parse(ShareIdempotencyKeyParserV1, idempotencyKeyValue, 'share idempotency key');
    const result = await this.coordinator.dispatchShared({
      path,
      method,
      ...(body === undefined ? {} : { body }),
      ...(csrfToken === undefined ? {} : { csrfToken }),
      ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
      ...(signal === undefined ? {} : { signal }),
    });
    if (result.kind !== 'ok') return result;
    const { response, body: responseBody } = result.value;
    if (!response.ok) return decodeError(response.status, responseBody);
    if (!successStatuses.includes(response.status)) return { kind: 'corrupt_response' };
    if (parser === null)
      return response.status === 204 && responseBody === null
        ? { kind: 'ok', value: null }
        : { kind: 'corrupt_response' };
    const parsed = parser.parse(responseBody);
    return parsed.ok ? { kind: 'ok', value: parsed.data.value } : { kind: 'corrupt_response' };
  }
}

const decodeError = (status: number, body: unknown): ShareApiResult<never> => {
  if (isObject(body) && exactKeys(body, ['error'])) {
    const parsed = ShareErrorEnvelopeParserV1.parse(body);
    if (parsed.ok) return { kind: 'share_error', error: parsed.data.value.error };
  }
  return { kind: 'api_error', status };
};
