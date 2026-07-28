import { BoardSdkHttpClient, type BoardSdkHttpLogEventV1 } from '@sceneboard/board-sdk/http';

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
import type { BoardErrorV1 } from '@sceneboard/board-schema';

export type ProtectedBoardGatewayOptionsV1 = {
  baseUrl: string;
  fetch: typeof fetch;
  timeoutMs: number;
  tokens: TokenProviderV1;
  logger: { log(event: BoardSdkHttpLogEventV1): void };
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
    operation: (client: BoardSdkHttpClient) => Promise<T>,
  ): Promise<ProtectedGatewayResultV1<T>> {
    const snapshot = await this.options.tokens.snapshot();
    if (snapshot === null) return { connected: false };
    const client = this.client(snapshot);
    const value = await operation(client);
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
