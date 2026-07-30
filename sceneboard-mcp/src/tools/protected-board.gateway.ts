import { BoardSdkHttpClient, type BoardSdkHttpLogEventV1 } from '@sceneboard/board-sdk/http';
import { randomBytes } from 'node:crypto';

import {
  ConnectionHttpClientV1,
  type ConnectionHttpLocalErrorV1,
} from '../connection/connection-http.client.js';
import { ConnectionMediaHttpClientV1 } from '../connection/connection-media-http.client.js';
import type { CredentialSnapshotV1 } from '../credentials/token-provider.js';
import type { TokenProviderV1 } from '../credentials/token-provider.js';
import {
  ACCESS_TOKEN_PATTERN_V1,
  GENERATION_PATTERN_V1,
} from '../credentials/credential-record.js';
import { BoardErrorParserV1, type BoardErrorV1 } from '@sceneboard/board-schema';
import {
  accountApiKeyToolPolicyV1,
  type AccountApiKeyOperationV1,
  type AccountApiKeyToolNameV1,
} from './account-api-key-tool-policy.js';
import {
  LOCAL_EXPORT_MAX_BYTES_V1,
  type LocalExportArtifactV1,
  type LocalExportFormatV1,
} from '../exports/local-export-file.js';

export type ProtectedBoardGatewayOptionsV1 = {
  baseUrl: string;
  fetch: typeof fetch;
  timeoutMs: number;
  tokens: TokenProviderV1;
  logger: { log(event: BoardSdkHttpLogEventV1): void };
  credentialMode?: 'pairing' | 'api_key';
};

export type ProtectedGatewayResultV1<T> = { connected: false } | { connected: true; value: T };

export type ProtectedAuthorizationResultV1<T> =
  | { authorized: true; value: T }
  | { authorized: false; reason: 'not_connected' | 'credential_unavailable' }
  | { authorized: false; reason: 'board'; error: BoardErrorV1 }
  | { authorized: false; reason: 'local'; error: ConnectionHttpLocalErrorV1 };

export type AuthorizedBoardOperationContextV1 = Readonly<{
  snapshot: CredentialSnapshotV1;
  client: BoardSdkHttpClient;
  media: ConnectionMediaHttpClientV1;
}>;

export type BoardRenameGatewayResultV1 =
  | { ok: true; value: { boardId: string; title: string; updatedAt: string } }
  | { ok: false; source: 'board'; error: BoardErrorV1 }
  | {
      ok: false;
      source: 'local';
      error: { code: 'RESPONSE_INVALID' | 'TRANSPORT_ERROR' };
    };

export type BoardExportGatewayResultV1 =
  | { ok: true; value: LocalExportArtifactV1 }
  | {
      ok: false;
      source: 'board';
      error: { code: string; message: string; retryable: boolean };
    }
  | {
      ok: false;
      source: 'local';
      error:
        | { code: 'CANCELLED' }
        | { code: 'TIMEOUT'; timeoutMs: 120_000 }
        | { code: 'TRANSPORT_ERROR' }
        | { code: 'RESPONSE_INVALID' };
    };

const EXPORT_HTTP_FAILURES_V1 = Object.freeze({
  EXPORT_INVALID_REQUEST: [400, false, 'Invalid export request'],
  EXPORT_UNAUTHENTICATED: [401, false, 'Authentication is required'],
  EXPORT_FORBIDDEN: [403, false, 'Export is not allowed'],
  EXPORT_NOT_FOUND: [404, false, 'Board or revision not found'],
  EXPORT_REQUIRED_CONTENT_UNSUPPORTED: [422, false, 'Required content cannot be exported'],
  EXPORT_BOUNDS_EXCEEDED: [413, false, 'Export bounds exceeded'],
  EXPORT_RATE_LIMITED: [429, true, 'Export capacity is temporarily unavailable'],
  EXPORT_RENDERER_UNAVAILABLE: [503, true, 'Export renderer is unavailable'],
  EXPORT_RENDER_TIMEOUT: [504, true, 'Export timed out'],
  EXPORT_ENCODE_FAILED: [500, true, 'Export encoding failed'],
  EXPORT_INTERNAL_ERROR: [500, true, 'Export failed'],
} as const);

const EXPORT_CONTENT_TYPES_V1 = Object.freeze({
  pdf: 'application/pdf',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
} as const);

export class ProtectedBoardGatewayV1 {
  constructor(private readonly options: ProtectedBoardGatewayOptionsV1) {}

  private client(snapshot: CredentialSnapshotV1): BoardSdkHttpClient {
    return new BoardSdkHttpClient({
      baseUrl: this.options.baseUrl,
      fetch: this.options.fetch,
      timeoutPolicy: { timeoutMs: this.options.timeoutMs },
      bearerTokenProvider: () => snapshot.accessToken,
      logger: this.options.logger,
    });
  }

  async call<T>(
    operation: (client: BoardSdkHttpClient, snapshot: CredentialSnapshotV1) => Promise<T>,
  ): Promise<ProtectedGatewayResultV1<T>>;
  async call<T>(
    toolName: AccountApiKeyToolNameV1,
    operationName: AccountApiKeyOperationV1,
    operation: (client: BoardSdkHttpClient, snapshot: CredentialSnapshotV1) => Promise<T>,
  ): Promise<ProtectedGatewayResultV1<T>>;
  async call<T>(
    toolOrOperation:
      | AccountApiKeyToolNameV1
      | ((client: BoardSdkHttpClient, snapshot: CredentialSnapshotV1) => Promise<T>),
    operationNameOrUndefined?: AccountApiKeyOperationV1,
    operationOrUndefined?: (
      client: BoardSdkHttpClient,
      snapshot: CredentialSnapshotV1,
    ) => Promise<T>,
  ): Promise<ProtectedGatewayResultV1<T>> {
    const toolName = typeof toolOrOperation === 'string' ? toolOrOperation : null;
    const operationName =
      typeof toolOrOperation === 'string' ? (operationNameOrUndefined ?? null) : null;
    const operation = typeof toolOrOperation === 'string' ? operationOrUndefined : toolOrOperation;
    if (operation === undefined) return { connected: false };
    const snapshot = await this.options.tokens.snapshot();
    if (snapshot === null) return { connected: false };
    if (this.options.credentialMode === 'api_key') {
      if (toolName === null || operationName === null) return { connected: false };
      const policy = accountApiKeyToolPolicyV1(toolName);
      if (policy === null || policy.operation !== operationName) return { connected: false };
      const connection = await new ConnectionHttpClientV1({
        baseUrl: this.options.baseUrl,
        fetch: this.options.fetch,
        timeoutMs: this.options.timeoutMs,
        logger: this.options.logger,
      }).get(null, randomBytes(16).toString('base64url'), snapshot.accessToken);
      if (!connection.ok) {
        if (connection.source === 'board') {
          if (connection.error.code === 'UNAUTHENTICATED')
            await this.options.tokens.invalidate(snapshot);
          return {
            connected: true,
            value: { ok: false, error: connection.error } as T,
          };
        }
        return { connected: false };
      }
      const credential = 'credential' in connection.value ? connection.value.credential : null;
      if (credential === null || !policy.scopes.every((scope) => credential.scopes.includes(scope)))
        return {
          connected: true,
          value: {
            ok: false,
            error: {
              protocolVersion: 1,
              type: 'board.error',
              code: 'FORBIDDEN',
              message: 'Insufficient API key scope',
              category: 'auth',
              retryable: false,
              httpStatusHint: 403,
              details: null,
            },
          } as T,
        };
    }
    const client = this.client(snapshot);
    const value = await operation(client, snapshot);
    if (
      value !== null &&
      typeof value === 'object' &&
      'ok' in value &&
      value.ok === false &&
      'error' in value &&
      value.error !== null &&
      typeof value.error === 'object' &&
      'code' in value.error &&
      value.error.code === 'UNAUTHENTICATED'
    ) {
      await this.options.tokens.invalidate(snapshot);
    }
    return { connected: true, value };
  }

  async renameBoard(input: {
    boardId: string;
    title: string;
    signal?: AbortSignal;
  }): Promise<ProtectedGatewayResultV1<BoardRenameGatewayResultV1>> {
    const result = await this.call(
      'board_rename',
      'board.rename',
      async (_client, snapshot): Promise<BoardRenameGatewayResultV1> => {
        const timeoutSignal = AbortSignal.timeout(this.options.timeoutMs);
        const signal =
          input.signal === undefined
            ? timeoutSignal
            : AbortSignal.any([input.signal, timeoutSignal]);
        let response: Response;
        try {
          response = await this.options.fetch(
            new URL(
              `/api/v1/boards/${encodeURIComponent(input.boardId)}/title`,
              this.options.baseUrl,
            ),
            {
              method: 'POST',
              redirect: 'manual',
              headers: {
                Accept: 'application/json',
                Authorization: `Bearer ${snapshot.accessToken}`,
                'Content-Type': 'application/json; charset=utf-8',
              },
              body: JSON.stringify({ title: input.title }),
              signal,
            },
          );
        } catch {
          return {
            ok: false,
            source: 'local',
            error: { code: 'TRANSPORT_ERROR' },
          };
        }
        if (
          response.redirected ||
          (response.status >= 300 && response.status < 400) ||
          response.headers.get('content-type')?.toLowerCase() !== 'application/json; charset=utf-8'
        ) {
          await response.body?.cancel().catch(() => undefined);
          return {
            ok: false,
            source: 'local',
            error: { code: 'RESPONSE_INVALID' },
          };
        }
        const bytes = await BoardSdkHttpClient.readBoundedResponseBodyV1(
          response,
          response.status === 200 ? 65_536 : 65_536,
          signal,
        );
        if (bytes === 'body_too_large' || bytes === 'response')
          return {
            ok: false,
            source: 'local',
            error: { code: 'RESPONSE_INVALID' },
          };
        const parsed = BoardSdkHttpClient.parseStrictJsonBytesV1(bytes);
        if (!parsed.ok)
          return {
            ok: false,
            source: 'local',
            error: { code: 'RESPONSE_INVALID' },
          };
        if (response.status !== 200) {
          const body =
            parsed.value !== null &&
            typeof parsed.value === 'object' &&
            !Array.isArray(parsed.value) &&
            Object.keys(parsed.value as Record<string, unknown>).length === 1
              ? (parsed.value as Record<string, unknown>).error
              : null;
          const error = BoardErrorParserV1.parse(body);
          if (!error.ok || error.data.value.httpStatusHint !== response.status)
            return {
              ok: false,
              source: 'local',
              error: { code: 'RESPONSE_INVALID' },
            };
          if (error.data.value.code === 'UNAUTHENTICATED')
            await this.options.tokens.invalidate(snapshot);
          return { ok: false, source: 'board', error: error.data.value };
        }
        const value =
          parsed.value !== null && typeof parsed.value === 'object' && !Array.isArray(parsed.value)
            ? (parsed.value as Record<string, unknown>)
            : null;
        if (
          value === null ||
          Object.keys(value).sort().join('\0') !== ['boardId', 'title', 'updatedAt'].join('\0') ||
          value.boardId !== input.boardId ||
          value.title !== input.title ||
          typeof value.updatedAt !== 'string' ||
          !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.updatedAt)
        )
          return {
            ok: false,
            source: 'local',
            error: { code: 'RESPONSE_INVALID' },
          };
        return {
          ok: true,
          value: {
            boardId: value.boardId,
            title: value.title,
            updatedAt: value.updatedAt,
          },
        };
      },
    );
    const rawValue = result.connected ? (result.value as unknown as Record<string, unknown>) : null;
    const rawError =
      rawValue !== null &&
      rawValue.ok === false &&
      !Object.hasOwn(rawValue, 'source') &&
      rawValue.error !== null &&
      typeof rawValue.error === 'object'
        ? (rawValue.error as Record<string, unknown>)
        : null;
    if (rawError !== null && 'protocolVersion' in rawError)
      return {
        connected: true,
        value: {
          ok: false,
          source: 'board',
          error: rawError as unknown as BoardErrorV1,
        },
      };
    return result;
  }

  async exportBoard(input: {
    boardId: string;
    revisionId: string | null;
    format: LocalExportFormatV1;
    signal?: AbortSignal;
  }): Promise<ProtectedGatewayResultV1<BoardExportGatewayResultV1>> {
    return this.call(
      'board_export',
      'export.render',
      async (_client, snapshot): Promise<BoardExportGatewayResultV1> => {
        const timeoutSignal = AbortSignal.timeout(120_000);
        const signal =
          input.signal === undefined
            ? timeoutSignal
            : AbortSignal.any([input.signal, timeoutSignal]);
        let response: Response;
        try {
          response = await this.options.fetch(
            new URL(
              `/api/v1/boards/${encodeURIComponent(input.boardId)}/exports`,
              this.options.baseUrl,
            ),
            {
              method: 'POST',
              redirect: 'manual',
              headers: {
                Accept: EXPORT_CONTENT_TYPES_V1[input.format],
                Authorization: `Bearer ${snapshot.accessToken}`,
                'Content-Type': 'application/json; charset=utf-8',
              },
              body: JSON.stringify({
                format: input.format,
                revisionId: input.revisionId,
              }),
              signal,
            },
          );
        } catch {
          if (input.signal?.aborted === true)
            return { ok: false, source: 'local', error: { code: 'CANCELLED' } };
          if (timeoutSignal.aborted)
            return {
              ok: false,
              source: 'local',
              error: { code: 'TIMEOUT', timeoutMs: 120_000 },
            };
          return { ok: false, source: 'local', error: { code: 'TRANSPORT_ERROR' } };
        }
        if (response.redirected || (response.status >= 300 && response.status < 400)) {
          await response.body?.cancel().catch(() => undefined);
          return { ok: false, source: 'local', error: { code: 'RESPONSE_INVALID' } };
        }
        const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
        if (response.status === 200) {
          const contentLengthText = response.headers.get('content-length');
          const contentLength =
            contentLengthText !== null && /^(?:[1-9][0-9]*)$/u.test(contentLengthText)
              ? Number(contentLengthText)
              : Number.NaN;
          if (
            contentType !== EXPORT_CONTENT_TYPES_V1[input.format] ||
            !Number.isSafeInteger(contentLength) ||
            contentLength < 1 ||
            contentLength > LOCAL_EXPORT_MAX_BYTES_V1 ||
            response.body === null
          ) {
            await response.body?.cancel().catch(() => undefined);
            return { ok: false, source: 'local', error: { code: 'RESPONSE_INVALID' } };
          }
          return {
            ok: true,
            value: {
              format: input.format,
              contentType,
              contentLength,
              body: response.body,
            },
          };
        }
        if (contentType !== 'application/json; charset=utf-8') {
          await response.body?.cancel().catch(() => undefined);
          return { ok: false, source: 'local', error: { code: 'RESPONSE_INVALID' } };
        }
        const bytes = await BoardSdkHttpClient.readBoundedResponseBodyV1(response, 65_536, signal);
        if (bytes === 'response') {
          if (input.signal?.aborted === true)
            return { ok: false, source: 'local', error: { code: 'CANCELLED' } };
          if (timeoutSignal.aborted)
            return {
              ok: false,
              source: 'local',
              error: { code: 'TIMEOUT', timeoutMs: 120_000 },
            };
          return { ok: false, source: 'local', error: { code: 'TRANSPORT_ERROR' } };
        }
        if (bytes === 'body_too_large')
          return { ok: false, source: 'local', error: { code: 'RESPONSE_INVALID' } };
        const parsed = BoardSdkHttpClient.parseStrictJsonBytesV1(bytes);
        const root =
          parsed.ok &&
          parsed.value !== null &&
          typeof parsed.value === 'object' &&
          !Array.isArray(parsed.value)
            ? (parsed.value as Record<string, unknown>)
            : null;
        const rawError =
          root !== null &&
          Object.keys(root).sort().join('\0') === ['error', 'ok'].join('\0') &&
          root.ok === false &&
          root.error !== null &&
          typeof root.error === 'object' &&
          !Array.isArray(root.error)
            ? (root.error as Record<string, unknown>)
            : null;
        const definition =
          rawError !== null &&
          typeof rawError.code === 'string' &&
          Object.hasOwn(EXPORT_HTTP_FAILURES_V1, rawError.code)
            ? EXPORT_HTTP_FAILURES_V1[rawError.code as keyof typeof EXPORT_HTTP_FAILURES_V1]
            : null;
        if (
          rawError === null ||
          Object.keys(rawError).sort().join('\0') !== ['code', 'message', 'retryable'].join('\0') ||
          typeof rawError.code !== 'string' ||
          definition === null ||
          definition[0] !== response.status ||
          rawError.retryable !== definition[1] ||
          rawError.message !== definition[2]
        )
          return { ok: false, source: 'local', error: { code: 'RESPONSE_INVALID' } };
        if (rawError.code === 'EXPORT_UNAUTHENTICATED')
          await this.options.tokens.invalidate(snapshot);
        return {
          ok: false,
          source: 'board',
          error: {
            code: rawError.code,
            message: definition[2],
            retryable: definition[1],
          },
        };
      },
    );
  }

  async withAuthorizedBoardOperation<T>(
    input: Readonly<{
      boardId: string;
      requestId: string;
      requiredCapabilities: readonly string[];
      signal?: AbortSignal;
    }>,
    operation: (context: AuthorizedBoardOperationContextV1) => Promise<T>,
  ): Promise<ProtectedAuthorizationResultV1<T>> {
    let rawSnapshot: CredentialSnapshotV1 | null;
    try {
      rawSnapshot = await this.options.tokens.snapshot();
    } catch {
      return { authorized: false, reason: 'credential_unavailable' };
    }
    if (rawSnapshot === null) return { authorized: false, reason: 'not_connected' };
    if (
      this.options.credentialMode === 'api_key' ||
      rawSnapshot.version !== 1 ||
      typeof rawSnapshot.generation !== 'string' ||
      !GENERATION_PATTERN_V1.test(rawSnapshot.generation) ||
      typeof rawSnapshot.accessToken !== 'string' ||
      !ACCESS_TOKEN_PATTERN_V1.test(rawSnapshot.accessToken)
    )
      return { authorized: false, reason: 'credential_unavailable' };
    const snapshot = Object.freeze({ ...rawSnapshot });
    const connection = await new ConnectionHttpClientV1({
      baseUrl: this.options.baseUrl,
      fetch: this.options.fetch,
      timeoutMs: this.options.timeoutMs,
      logger: this.options.logger,
    }).get(input.boardId, input.requestId, snapshot.accessToken, input.signal);
    if (!connection.ok) {
      if (connection.source === 'board') {
        if (connection.error.code === 'UNAUTHENTICATED')
          await this.options.tokens.invalidate(snapshot);
        return { authorized: false, reason: 'board', error: connection.error };
      }
      return { authorized: false, reason: 'local', error: connection.error };
    }
    if (!('grant' in connection.value))
      return { authorized: false, reason: 'credential_unavailable' };
    const selected = connection.value.selectedBoard;
    const grant = connection.value.grant;
    if (
      selected === null ||
      !input.requiredCapabilities.every(
        (capability) =>
          grant.scopes.includes(capability as never) &&
          selected.capabilities.grantedCapabilities.includes(capability as never),
      )
    )
      return {
        authorized: false,
        reason: 'board',
        error: {
          protocolVersion: 1,
          type: 'board.error',
          code: 'BOARD_NOT_FOUND',
          message: 'Board not found',
          category: 'not_found',
          retryable: false,
          httpStatusHint: 404,
          details: null,
        },
      };
    return {
      authorized: true,
      value: await operation({
        snapshot,
        client: this.client(snapshot),
        media: new ConnectionMediaHttpClientV1({
          baseUrl: this.options.baseUrl,
          fetch: this.options.fetch,
          timeoutMs: this.options.timeoutMs,
          logger: this.options.logger,
        }),
      }),
    };
  }
}
