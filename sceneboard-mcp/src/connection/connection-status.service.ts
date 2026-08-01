import { randomBytes } from 'node:crypto';

import type { LoadedBoardConfigV1, SafeConfigSourceV1 } from '../config/board-config.js';
import type { TokenProviderV1 } from '../credentials/token-provider.js';
import type {
  ConnectionStatusPortResultV1,
  ConnectionStatusPortV1,
} from '../tools/connection.tools.js';
import {
  ConnectionHttpClientV1,
  type ConnectionHttpLocalErrorV1,
} from './connection-http.client.js';

export type SafeConfigSummaryV1 = {
  source: SafeConfigSourceV1;
  profile: string;
  baseOrigin: string;
  timeoutMs: number;
  hasToken: boolean;
};

const summary = (loaded: LoadedBoardConfigV1, hasToken: boolean): SafeConfigSummaryV1 => ({
  source: loaded.source,
  profile: loaded.config.profile,
  baseOrigin: loaded.config.baseUrl,
  timeoutMs: loaded.config.timeoutMs,
  hasToken,
});

const localValue = (error: ConnectionHttpLocalErrorV1): Record<string, unknown> => {
  if (error.code === 'CANCELLED')
    return {
      code: 'BOARD_MCP_CANCELLED',
      message: 'Connection check was cancelled',
      retryable: false,
      details: null,
    };
  if (error.code === 'TIMEOUT')
    return {
      code: 'BOARD_MCP_TIMEOUT',
      message: 'SceneBoard connection timed out',
      retryable: true,
      details: { timeoutMs: error.timeoutMs },
    };
  if (error.code === 'TRANSPORT_ERROR')
    return {
      code: 'BOARD_MCP_TRANSPORT_ERROR',
      message: 'SceneBoard transport is unavailable',
      retryable: true,
      details: { phase: error.phase },
    };
  return {
    code: 'BOARD_MCP_RESPONSE_INVALID',
    message: 'SceneBoard response is invalid',
    retryable: false,
    details: { reason: error.reason },
  };
};

type StatusDeadlineV1 = {
  signal: AbortSignal;
  cause(): 'caller' | 'timeout' | null;
  dispose(): void;
};

const statusDeadline = (timeoutMs: number, callerSignal?: AbortSignal): StatusDeadlineV1 => {
  const controller = new AbortController();
  let cause: 'caller' | 'timeout' | null = null;
  const abortFromCaller = (): void => {
    if (cause !== null) return;
    cause = 'caller';
    controller.abort(callerSignal?.reason);
  };
  if (callerSignal?.aborted) abortFromCaller();
  else callerSignal?.addEventListener('abort', abortFromCaller, { once: true });
  const timer = setTimeout(() => {
    if (cause !== null) return;
    cause = 'timeout';
    controller.abort(new DOMException('Connection deadline exceeded', 'TimeoutError'));
  }, timeoutMs);
  return {
    signal: controller.signal,
    cause: () => cause,
    dispose: () => {
      clearTimeout(timer);
      callerSignal?.removeEventListener('abort', abortFromCaller);
    },
  };
};

const waitWithinDeadline = async <Value>(
  operation: Promise<Value>,
  signal: AbortSignal,
): Promise<Value> => {
  signal.throwIfAborted();
  return new Promise<Value>((resolve, reject) => {
    const cleanup = (): void => signal.removeEventListener('abort', onAbort);
    const onAbort = (): void => {
      cleanup();
      reject(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    operation.then(
      (value) => {
        cleanup();
        if (signal.aborted) reject(signal.reason);
        else resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
};

const cancelledResult = (): ConnectionStatusPortResultV1 => ({
  ok: false,
  source: 'mcp',
  value: localValue({ code: 'CANCELLED', retryable: false }),
});

export class ConnectionStatusServiceV1 implements ConnectionStatusPortV1 {
  constructor(
    private readonly loaded: LoadedBoardConfigV1,
    private readonly tokens: TokenProviderV1,
    private readonly client: ConnectionHttpClientV1,
  ) {}

  async status(
    boardId: string | null,
    requestId: string,
    signal?: AbortSignal,
  ): Promise<ConnectionStatusPortResultV1> {
    const deadline = statusDeadline(this.loaded.config.timeoutMs, signal);
    try {
      let snapshot;
      try {
        deadline.signal.throwIfAborted();
        snapshot = await waitWithinDeadline(this.tokens.snapshot(deadline.signal), deadline.signal);
      } catch {
        if (deadline.cause() === 'caller') return cancelledResult();
        if (deadline.cause() === 'timeout')
          return {
            ok: true,
            value: {
              state: 'backend_unavailable',
              config: summary(this.loaded, false),
              connection: null,
              lastErrorCode: 'BOARD_MCP_TIMEOUT',
            },
          };
        return {
          ok: false,
          source: 'mcp',
          value: {
            code: 'BOARD_MCP_INTERNAL_ERROR',
            message: 'Connection state is unavailable',
            retryable: false,
            details: { incidentId: randomBytes(16).toString('base64url') },
          },
        };
      }
      if (snapshot === null)
        return {
          ok: true,
          value: {
            state: 'credential_missing',
            config: summary(this.loaded, false),
            connection: null,
            lastErrorCode: null,
          },
        };
      let result;
      try {
        result = await waitWithinDeadline(
          this.client.get(boardId, requestId, snapshot.accessToken, deadline.signal),
          deadline.signal,
        );
      } catch {
        if (deadline.cause() === 'caller') return cancelledResult();
        if (deadline.cause() === 'timeout')
          return {
            ok: true,
            value: {
              state: 'backend_unavailable',
              config: summary(this.loaded, true),
              connection: null,
              lastErrorCode: 'BOARD_MCP_TIMEOUT',
            },
          };
        throw new Error('connection deadline invariant failed');
      }
      if (deadline.cause() === 'caller') return cancelledResult();
      if (deadline.cause() === 'timeout')
        return {
          ok: true,
          value: {
            state: 'backend_unavailable',
            config: summary(this.loaded, true),
            connection: null,
            lastErrorCode: 'BOARD_MCP_TIMEOUT',
          },
        };
      if (result.ok)
        return {
          ok: true,
          value: {
            state: 'connected',
            config: summary(this.loaded, true),
            connection: result.value,
            lastErrorCode: null,
          },
        };
      if (result.source === 'board') {
        if (result.error.code !== 'UNAUTHENTICATED') {
          return {
            ok: false,
            source: 'board',
            value: result.error as unknown as Record<string, unknown>,
          };
        }
        try {
          await waitWithinDeadline(
            this.tokens.invalidate(snapshot, deadline.signal),
            deadline.signal,
          );
        } catch {
          if (deadline.cause() === 'caller') return cancelledResult();
          if (deadline.cause() === 'timeout')
            return {
              ok: true,
              value: {
                state: 'backend_unavailable',
                config: summary(this.loaded, true),
                connection: null,
                lastErrorCode: 'BOARD_MCP_TIMEOUT',
              },
            };
        }
        return {
          ok: true,
          value: {
            state: 'credential_invalid',
            config: summary(this.loaded, false),
            connection: null,
            lastErrorCode: 'UNAUTHENTICATED',
          },
        };
      }
      if (result.error.code === 'CANCELLED') return cancelledResult();
      const translated = localValue(result.error);
      return {
        ok: true,
        value: {
          state: 'backend_unavailable',
          config: summary(this.loaded, true),
          connection: null,
          lastErrorCode: translated.code,
        },
      };
    } finally {
      deadline.dispose();
    }
  }

  async probeWithToken(accessToken: string, signal?: AbortSignal): Promise<boolean> {
    const requestId = randomBytes(16).toString('base64url');
    return (await this.client.get(null, requestId, accessToken, signal)).ok;
  }
}

export class ApiKeyConnectionStatusServiceV1 implements ConnectionStatusPortV1 {
  constructor(
    private readonly loaded: LoadedBoardConfigV1,
    private readonly tokens: TokenProviderV1,
    private readonly client: ConnectionHttpClientV1,
  ) {}

  private config(referenceConfigured: boolean): Record<string, unknown> {
    return {
      source:
        this.loaded.config.accessTokenRef === 'env://SCENEBOARD_API_KEY' ? 'env' : 'private_store',
      referenceConfigured,
    };
  }

  private state(
    state: 'credential_missing' | 'credential_invalid' | 'backend_unavailable',
    referenceConfigured: boolean,
    lastErrorCode:
      | 'API_KEY_CREDENTIAL_MISSING'
      | 'API_KEY_CREDENTIAL_INVALID'
      | 'API_KEY_BACKEND_UNAVAILABLE'
      | 'API_KEY_BACKEND_RESPONSE_INVALID',
    retryable: boolean,
  ): ConnectionStatusPortResultV1 {
    return {
      ok: true,
      value: {
        credentialMode: 'api_key',
        state,
        config: this.config(referenceConfigured),
        connection: null,
        lastErrorCode,
        retryable,
      },
    };
  }

  async status(
    boardId: string | null,
    requestId: string,
    signal?: AbortSignal,
  ): Promise<ConnectionStatusPortResultV1> {
    const deadline = statusDeadline(this.loaded.config.timeoutMs, signal);
    try {
      let snapshot;
      try {
        deadline.signal.throwIfAborted();
        snapshot = await waitWithinDeadline(this.tokens.snapshot(deadline.signal), deadline.signal);
      } catch {
        if (deadline.cause() === 'caller') return cancelledResult();
        if (deadline.cause() === 'timeout')
          return this.state('backend_unavailable', true, 'API_KEY_BACKEND_UNAVAILABLE', true);
        return this.state('credential_invalid', true, 'API_KEY_CREDENTIAL_INVALID', false);
      }
      if (
        snapshot === null &&
        'credentialInvalidated' in this.tokens &&
        typeof this.tokens.credentialInvalidated === 'function' &&
        this.tokens.credentialInvalidated()
      )
        return this.state('credential_invalid', true, 'API_KEY_CREDENTIAL_INVALID', false);
      if (snapshot === null)
        return this.state('credential_missing', false, 'API_KEY_CREDENTIAL_MISSING', false);
      let result;
      try {
        result = await waitWithinDeadline(
          this.client.get(boardId, requestId, snapshot.accessToken, deadline.signal),
          deadline.signal,
        );
      } catch {
        if (deadline.cause() === 'caller') return cancelledResult();
        if (deadline.cause() === 'timeout')
          return this.state('backend_unavailable', true, 'API_KEY_BACKEND_UNAVAILABLE', true);
        throw new Error('connection deadline invariant failed');
      }
      if (deadline.cause() === 'caller') return cancelledResult();
      if (deadline.cause() === 'timeout')
        return this.state('backend_unavailable', true, 'API_KEY_BACKEND_UNAVAILABLE', true);
      if (result.ok) {
        if (!('credential' in result.value))
          return this.state('backend_unavailable', true, 'API_KEY_BACKEND_RESPONSE_INVALID', true);
        return {
          ok: true,
          value: {
            credentialMode: 'api_key',
            state: 'connected',
            config: this.config(true),
            connection: result.value,
            lastErrorCode: null,
            retryable: false,
          },
        };
      }
      if (result.source === 'board') {
        if (result.error.code !== 'UNAUTHENTICATED')
          return {
            ok: false,
            source: 'board',
            value: result.error as unknown as Record<string, unknown>,
          };
        try {
          await waitWithinDeadline(
            this.tokens.invalidate(snapshot, deadline.signal),
            deadline.signal,
          );
        } catch {
          if (deadline.cause() === 'caller') return cancelledResult();
          if (deadline.cause() === 'timeout')
            return this.state('backend_unavailable', true, 'API_KEY_BACKEND_UNAVAILABLE', true);
        }
        return this.state('credential_invalid', true, 'API_KEY_CREDENTIAL_INVALID', false);
      }
      if (result.error.code === 'CANCELLED') return cancelledResult();
      return this.state(
        'backend_unavailable',
        true,
        result.error.code === 'RESPONSE_INVALID'
          ? 'API_KEY_BACKEND_RESPONSE_INVALID'
          : 'API_KEY_BACKEND_UNAVAILABLE',
        true,
      );
    } finally {
      deadline.dispose();
    }
  }
}

export class UnconfiguredConnectionStatusServiceV1 implements ConnectionStatusPortV1 {
  async status(
    _boardId: string | null,
    _requestId: string,
    _signal?: AbortSignal,
  ): Promise<ConnectionStatusPortResultV1> {
    return {
      ok: true,
      value: {
        state: 'not_configured',
        config: null,
        connection: null,
        lastErrorCode: 'BOARD_MCP_CONFIG_INVALID',
      },
    };
  }
}
