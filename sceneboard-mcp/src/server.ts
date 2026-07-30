import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

import { ConnectionHttpClientV1 } from './connection/connection-http.client.js';
import {
  ApiKeyConnectionStatusServiceV1,
  ConnectionStatusServiceV1,
  UnconfiguredConnectionStatusServiceV1,
} from './connection/connection-status.service.js';
import { BoardConfigError, type LoadedBoardConfigV1 } from './config/board-config.js';
import { discoverBoardConfigV1 } from './config/config-discovery.js';
import { resolveSecretReferenceV1 } from './config/secret-reference.js';
import { InstallationIdentityStoreV1 } from './credentials/installation-identity.store.js';
import { LinuxProfileLeaseHelperAdapterV1 } from './credentials/linux-profile-lease-helper.adapter.js';
import { PrivateFileCredentialStoreV1 } from './credentials/private-file-credential.store.js';
import { PrivateFileApiKeyStoreV1 } from './credentials/private-file-api-key.store.js';
import { ProfileLeaseProviderV1 } from './credentials/profile-lease.provider.js';
import {
  EnvironmentTokenProviderV1,
  ApiKeyTokenProviderV1,
  StoredTokenProviderV1,
  type CredentialSnapshotV1,
  type TokenProviderV1,
} from './credentials/token-provider.js';
import { SafeStderrLoggerV1 } from './diagnostics/safe-logger.js';
import { PairingHttpClientV1 } from './pairing/pairing-http.client.js';
import {
  PairingSessionOwnerV1,
  type PairingCoordinatorPortV1,
} from './pairing/pairing-session.owner.js';
import { UnavailablePairingCoordinatorV1 } from './pairing/unavailable-pairing.coordinator.js';
import { ProtectedBoardGatewayV1 } from './tools/protected-board.gateway.js';
import { registerCoreToolsV1, type CoreToolRegistryV1 } from './tools/register-tools.js';
import type { ConnectionStatusPortV1 } from './tools/connection.tools.js';
import { LocalExportFileV1 } from './exports/local-export-file.js';

class MissingTokenProviderV1 implements TokenProviderV1 {
  async snapshot(): Promise<CredentialSnapshotV1 | null> {
    return null;
  }
  async invalidate(_snapshot: CredentialSnapshotV1): Promise<void> {}
}

export type BoardMcpServerOptionsV1 = {
  argv?: readonly string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  stderr?: (line: string) => void;
  probeOnStart?: boolean;
};

export type BoardMcpServerRuntimeV1 = {
  server: McpServer;
  registry: CoreToolRegistryV1;
  authenticated: boolean;
  connect(transport: Transport): Promise<void>;
  close(): Promise<void>;
};

type ConfiguredRuntimeParts = {
  loaded: LoadedBoardConfigV1;
  tokens: TokenProviderV1;
  pairing: PairingCoordinatorPortV1;
  connections: ConnectionStatusPortV1;
  credentialMode: 'pairing' | 'api_key';
};

const configuredParts = async (
  loaded: LoadedBoardConfigV1,
  env: NodeJS.ProcessEnv,
  fetchImplementation: typeof fetch,
  logger: SafeStderrLoggerV1,
): Promise<ConfiguredRuntimeParts> => {
  const reference = resolveSecretReferenceV1(loaded.config, env);
  const credentialMode = loaded.config.credentialMode ?? 'pairing';
  let tokens: TokenProviderV1;
  let pairing: PairingCoordinatorPortV1;
  const connectionClient = new ConnectionHttpClientV1({
    baseUrl: loaded.config.baseUrl,
    fetch: fetchImplementation,
    timeoutMs: loaded.config.timeoutMs,
    logger,
  });
  if (credentialMode === 'api_key') {
    if (reference.kind === 'environment') {
      tokens = new ApiKeyTokenProviderV1({
        kind: 'environment',
        apiKey: env.SCENEBOARD_API_KEY,
      });
    } else {
      const store = new PrivateFileApiKeyStoreV1(reference.stateDirectory);
      tokens = new ApiKeyTokenProviderV1({ kind: 'store', store });
    }
    pairing = new UnavailablePairingCoordinatorV1('read_only');
    return {
      loaded,
      tokens,
      pairing,
      connections: new ApiKeyConnectionStatusServiceV1(loaded, tokens, connectionClient),
      credentialMode,
    };
  }
  if (reference.kind === 'environment') {
    tokens = new EnvironmentTokenProviderV1(env.SCENEBOARD_ACCESS_TOKEN);
    pairing = new UnavailablePairingCoordinatorV1('read_only');
  } else {
    const helperPath = fileURLToPath(new URL('../native/profile-lease-helper', import.meta.url));
    const digestPath = fileURLToPath(
      new URL('../native/profile-lease-helper.sha256', import.meta.url),
    );
    const leases = new ProfileLeaseProviderV1(
      new LinuxProfileLeaseHelperAdapterV1(helperPath, digestPath),
    );
    const store = new PrivateFileCredentialStoreV1(reference.stateDirectory);
    const available =
      (await leases.verify().catch(() => false)) &&
      (await store.preflight().then(
        () => true,
        () => false,
      ));
    if (!available) {
      tokens = new MissingTokenProviderV1();
      pairing = new UnavailablePairingCoordinatorV1('unavailable');
    } else {
      tokens = new StoredTokenProviderV1(store, leases);
      const installations = new InstallationIdentityStoreV1(reference.stateDirectory);
      let connectionProbe: (
        accessToken: string,
        signal?: AbortSignal,
      ) => Promise<boolean> = async () => false;
      pairing = new PairingSessionOwnerV1(
        store,
        installations,
        leases,
        (proofHeaderProvider) =>
          new PairingHttpClientV1({
            baseUrl: loaded.config.baseUrl,
            fetch: fetchImplementation,
            timeoutMs: loaded.config.timeoutMs,
            proofHeaderProvider,
          }),
        (accessToken, signal) => connectionProbe(accessToken, signal),
      );
      const connections = new ConnectionStatusServiceV1(loaded, tokens, connectionClient);
      connectionProbe = (accessToken, signal) => connections.probeWithToken(accessToken, signal);
      return { loaded, tokens, pairing, connections, credentialMode };
    }
  }
  return {
    loaded,
    tokens,
    pairing,
    connections: new ConnectionStatusServiceV1(loaded, tokens, connectionClient),
    credentialMode,
  };
};

export const createBoardMcpServerV1 = async (
  options: BoardMcpServerOptionsV1 = {},
): Promise<BoardMcpServerRuntimeV1> => {
  const env = options.env ?? process.env;
  const logger = new SafeStderrLoggerV1(options.stderr);
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  let pairing: PairingCoordinatorPortV1 = new UnavailablePairingCoordinatorV1('unavailable');
  let connections: ConnectionStatusPortV1 = new UnconfiguredConnectionStatusServiceV1();
  let gateway = new ProtectedBoardGatewayV1({
    baseUrl: 'http://127.0.0.1:1',
    fetch: async () => {
      throw new Error('unconfigured');
    },
    timeoutMs: 1_000,
    tokens: new MissingTokenProviderV1(),
    logger,
  });
  let authenticated = false;
  let credentialMode: 'pairing' | 'api_key' = 'pairing';
  try {
    const loaded = await discoverBoardConfigV1({
      argv: options.argv ?? process.argv.slice(2),
      cwd: options.cwd ?? process.cwd(),
      env,
    });
    const parts = await configuredParts(loaded, env, fetchImplementation, logger);
    credentialMode = parts.credentialMode;
    pairing = parts.pairing;
    connections = parts.connections;
    gateway = new ProtectedBoardGatewayV1({
      baseUrl: parts.loaded.config.baseUrl,
      fetch: fetchImplementation,
      timeoutMs: parts.loaded.config.timeoutMs,
      tokens: parts.tokens,
      logger,
      credentialMode,
    });
    if (options.probeOnStart !== false) {
      const probe = await parts.connections.status(null, randomBytes(16).toString('base64url'));
      authenticated = probe.ok && probe.value.state === 'connected';
    }
  } catch (error) {
    logger.log({
      event: error instanceof BoardConfigError ? 'config_invalid' : 'startup_boundary_unavailable',
    });
  }
  const server = new McpServer(
    { name: 'SceneBoard', version: '0.0.0' },
    {
      capabilities: { tools: { listChanged: true } },
    },
  );
  const registry = registerCoreToolsV1(server, {
    gateway,
    pairing,
    connections,
    authenticated,
    downstreamReady: true,
    credentialMode,
    localExports: new LocalExportFileV1({
      manifestPath: fileURLToPath(
        new URL('../native/local-export-helper.manifest.json', import.meta.url),
      ),
    }),
  });
  let closed = false;
  return {
    server,
    registry,
    authenticated,
    connect: (transport) => server.connect(transport),
    close: async () => {
      if (closed) return;
      closed = true;
      await pairing.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    },
  };
};
