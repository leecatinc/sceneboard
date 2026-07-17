import { BoardSdkHttpClient, type BoardSdkHttpLogEventV1 } from '@leecat-board/board-sdk/http';

import type { TokenProviderV1 } from '../credentials/token-provider.js';

export type ProtectedBoardGatewayOptionsV1 = {
  baseUrl: string;
  fetch: typeof fetch;
  timeoutMs: number;
  tokens: TokenProviderV1;
  logger: { log(event: BoardSdkHttpLogEventV1): void };
};

export type ProtectedGatewayResultV1<T> =
  | { connected: false }
  | { connected: true; value: T };

export class ProtectedBoardGatewayV1 {
  constructor(private readonly options: ProtectedBoardGatewayOptionsV1) {}

  async call<T>(operation: (client: BoardSdkHttpClient) => Promise<T>): Promise<ProtectedGatewayResultV1<T>> {
    const snapshot = await this.options.tokens.snapshot();
    if (snapshot === null) return { connected: false };
    const client = new BoardSdkHttpClient({
      baseUrl: this.options.baseUrl,
      fetch: this.options.fetch,
      timeoutPolicy: { timeoutMs: this.options.timeoutMs },
      bearerTokenProvider: () => snapshot.accessToken,
      logger: this.options.logger,
    });
    const value = await operation(client);
    if (value !== null && typeof value === 'object' && 'ok' in value && value.ok === false
      && 'error' in value && value.error !== null && typeof value.error === 'object'
      && 'code' in value.error && value.error.code === 'UNAUTHENTICATED') {
      await this.options.tokens.invalidate(snapshot);
    }
    return { connected: true, value };
  }
}
