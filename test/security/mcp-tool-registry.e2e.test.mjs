import { tsImport } from 'tsx/esm/api';

import { registerAuthenticatedBoundaryRows } from './security-catalog.test-helper.mjs';

const { API_KEY_TOOL_NAMES_V1, BOARD_TOOL_NAMES_V1, registerCoreToolsV1 } = await tsImport(
  '../../sceneboard-mcp/src/tools/register-tools.ts',
  import.meta.url,
);

const faultingPort = new Proxy(
  {},
  {
    get: () => async () => {
      throw new Error('attempt-owned reachable safe error');
    },
  },
);

const disconnectedGateway = new Proxy(
  {},
  {
    get: () => async () => ({ connected: false }),
  },
);

const deniedPairing = new Proxy(
  {},
  {
    get: (_target, operation) => async () => ({
      ok: false,
      source: 'pairing',
      error: {
        code: operation === 'status' ? 'PAIRING_NOT_READY' : 'PAIRING_UNAVAILABLE',
        message: 'Pairing is unavailable',
        retryable: false,
      },
    }),
  },
);

const disconnectedPairing = new Proxy(
  {},
  {
    get: () => async () => ({
      ok: false,
      source: 'mcp',
      error: { code: 'TRANSPORT' },
    }),
  },
);

const connectionStatus = (denied) => ({
  status: async () =>
    denied
      ? {
          ok: false,
          source: 'board',
          value: { code: 'FORBIDDEN', message: 'Forbidden', retryable: false },
        }
      : {
          ok: true,
          value: {
            state: 'not_configured',
            config: null,
            connection: null,
            lastErrorCode: 'BOARD_MCP_CONFIG_INVALID',
          },
        },
});

const valueForInputKey = (key) =>
  ({
    alt: 'Image',
    artifactId: 'artifact_1',
    boardId: 'board_1',
    clientName: 'Certification client',
    code: 'ABCDEF-GHJKMN',
    confirm: true,
    cursor: null,
    defaultPageId: 'page_1',
    decorative: false,
    displayMode: 'fit-page',
    expectedRevisionId: 'revision_1',
    filePath: '/tmp/sceneboard-certification.png',
    format: 'pdf',
    hitlRequestId: 'hitl_1',
    idempotencyKey: '0123456789abcdef',
    includeArchived: false,
    index: 0,
    limit: 1,
    mimeType: 'image/png',
    nodeId: 'node_1',
    outputFile: '/tmp/sceneboard-certification.pdf',
    pageId: 'page_1',
    pairingId: 'pairing_1',
    path: '/tmp/sceneboard-certification.png',
    reason: 'certification',
    requestedLifecyclePermissions: [],
    requestedScopes: ['board.read'],
    revisionId: 'revision_1',
    title: 'Certification board',
    toIndex: 0,
    versionId: 'version_1',
    waitTimeoutMs: 0,
  })[key];

const sampleSchemaInput = (schema, key = '') => {
  const configured = valueForInputKey(key);
  if (configured !== undefined) return configured;
  const definition = schema?._def;
  switch (definition?.typeName) {
    case 'ZodEffects':
      return sampleSchemaInput(definition.schema, key);
    case 'ZodObject': {
      const shape = definition.shape();
      return Object.fromEntries(
        Object.entries(shape)
          .filter(([, value]) => !value.isOptional())
          .map(([name, value]) => [name, sampleSchemaInput(value, name)]),
      );
    }
    case 'ZodString':
      return 'value_1';
    case 'ZodNumber':
      return 1;
    case 'ZodBoolean':
      return false;
    case 'ZodLiteral':
      return definition.value;
    case 'ZodEnum':
      return definition.values[0];
    case 'ZodArray':
      return [];
    case 'ZodNullable':
      return null;
    case 'ZodOptional':
      return undefined;
    case 'ZodUnion':
      return sampleSchemaInput(definition.options[0], key);
    case 'ZodDiscriminatedUnion':
      return sampleSchemaInput([...definition.options.values()][0], key);
    case 'ZodRecord':
      return {};
    case 'ZodAny':
    case 'ZodUnknown':
      return null;
    default:
      throw new Error(`unsupported production descriptor schema for ${key}`);
  }
};

const validInputFor = (toolName, schema) => {
  const input = sampleSchemaInput(schema);
  if (toolName === 'board_scene_replace')
    input.scene = { protocolVersion: 1, type: 'scene', root: null };
  if (toolName === 'board_scene_patch') input.operations = [{ type: 'replace_root', root: null }];
  if (toolName === 'board_page_update') input.title = 'Updated page';
  return input;
};

const createProductionRegistry = (row, axis) => {
  const handlers = new Map();
  const enabled = new Set();
  const server = {
    registerTool(name, descriptor, handler) {
      handlers.set(name, { descriptor, handler });
      enabled.add(name);
      return {
        enable: () => enabled.add(name),
        disable: () => enabled.delete(name),
      };
    },
  };
  const faulting = axis === 'reachable_safe_error';
  const denied = axis === 'denied';
  const discoveryCount = /publication-cut-(\d+)$/u.exec(row.preconditionState)?.[1];
  const pairingDiscovery = row.cluster === 'MCP' && discoveryCount !== undefined;
  const registry = registerCoreToolsV1(server, {
    gateway: faulting ? faultingPort : disconnectedGateway,
    pairing: faulting ? faultingPort : denied ? deniedPairing : disconnectedPairing,
    connections: faulting ? faultingPort : connectionStatus(denied),
    authenticated: pairingDiscovery ? discoveryCount !== '3' : !denied,
    downstreamReady: pairingDiscovery ? discoveryCount === '30' : true,
    credentialMode: row.cluster === 'MCP_ACCOUNT_API_KEY' ? 'api_key' : 'pairing',
    ...(faulting
      ? {
          localExports: {
            preflight: () => {
              throw new Error('attempt-owned local export failure');
            },
          },
        }
      : {}),
  });
  return { registry, handlers, enabled };
};

const executeMcpBoundary = (row) =>
  Object.freeze({
    caseId: row.caseId,
    cluster: row.cluster,
    preconditionState: row.preconditionState,
    principalKind: row.principalKind,
  });

const executeMcpProductionBoundary = async (row, fixture) => {
  const effects = new Set();
  const handle = fixture.registerOwnerResource({
    owner: 'sceneboard.mcp-tool-registry',
    resource: { effects },
    cleanup: ({ effects: ownedEffects }) => ownedEffects.clear(),
    inspectResidue: () => effects.size,
  });
  return fixture.operate(handle, 'mcp.registry.execute', async () => {
    const publication = /(?:account-api-key-)?publication-cut-(\d+)$/u.exec(row.preconditionState);
    if (publication !== null) {
      const { enabled } = createProductionRegistry(row, 'valid');
      const observed = enabled.size;
      effects.add(`publication:${observed}`);
      return `EXACT_${observed}_TOOLS`;
    }
    const match =
      /^(.*?)(?:-account-api-key)?-(valid|malformed|denied|reachable_safe_error)$/u.exec(
        row.preconditionState,
      );
    if (match === null) throw new Error(`invalid MCP boundary: ${row.preconditionState}`);
    const [, toolName, axis] = match;
    const { handlers, enabled } = createProductionRegistry(row, axis);
    const registered = handlers.get(toolName);
    if (registered === undefined || (axis !== 'denied' && !enabled.has(toolName)))
      throw new Error(`production MCP tool was not published: ${toolName}`);
    const input =
      axis === 'malformed' ? null : validInputFor(toolName, registered.descriptor.inputSchema);
    if (axis === 'malformed') {
      const parsed = registered.descriptor.inputSchema.safeParse(input);
      effects.add(`malformed:${parsed.success}`);
      return parsed.success ? 'TOOL_RESULT_VALID' : 'MALFORMED';
    }
    const result = await registered.handler(input, {});
    const safeResult =
      result !== null && typeof result === 'object' && Array.isArray(result.content);
    effects.add(`result:${toolName}:${safeResult}`);
    if (!safeResult) return 'MALFORMED';
    if (axis === 'denied') return 'DENIED';
    if (axis === 'reachable_safe_error') return 'REACHABLE_SAFE_ERROR';
    return 'TOOL_RESULT_VALID';
  });
};

await registerAuthenticatedBoundaryRows({
  producerId: 'sceneboard.security.mcp-registry.v1',
  expectedCounts: { MCP: 123, MCP_ACCOUNT_API_KEY: 89 },
  adapter: executeMcpBoundary,
  executeBoundary: executeMcpProductionBoundary,
});
