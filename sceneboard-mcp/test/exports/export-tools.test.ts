import assert from 'node:assert/strict';
import test from 'node:test';

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  ARTIFACT_REQUEST_CAPABILITIES_V1,
  BOARD_EVENT_TYPES_V1,
  BOARD_LIMITS_V1,
  BOARD_MUTATION_COMMAND_TYPES_V1,
  BOARD_OPERATION_TYPES_V1,
  HITL_KINDS_V1,
  NODE_TYPES_V1,
} from '@sceneboard/board-schema';

import type { TokenProviderV1 } from '../../src/credentials/token-provider.js';
import type { LocalExportFileV1 } from '../../src/exports/local-export-file.js';
import { ExportToolHandlersV1 } from '../../src/tools/export.tools.js';
import { ProtectedBoardGatewayV1 } from '../../src/tools/protected-board.gateway.js';
import { toolOutputSchemaV1 } from '../../src/tools/tool-result.js';
import { BOARD_TOOL_ERROR_CODES_V1 } from '../../src/tools/register-tools.js';

const apiKey = `sbk_v1.${'A'.repeat(22)}.${'B'.repeat(43)}`;
const input = {
  boardId: 'board_synthetic',
  revisionId: 'revision_synthetic',
  format: 'pdf' as const,
  outputFile: '/tmp/sceneboard-export/synthetic.pdf',
};

const structured = (result: CallToolResult): Record<string, unknown> =>
  result.structuredContent as Record<string, unknown>;

test('missing and null revisions fail before local preflight, gateway access, or publication', async () => {
  let gatewayCalls = 0;
  let preflightCalls = 0;
  let publicationCalls = 0;
  const gateway = {
    exportBoard: async () => {
      gatewayCalls += 1;
      return { connected: false };
    },
  } as unknown as ProtectedBoardGatewayV1;
  const local = {
    preflight: () => {
      preflightCalls += 1;
      return { ok: false };
    },
    publish: async () => {
      publicationCalls += 1;
      throw new Error('must not publish');
    },
  } as unknown as LocalExportFileV1;
  const handler = new ExportToolHandlersV1(gateway, local);

  for (const invalid of [
    { boardId: input.boardId, format: input.format, outputFile: input.outputFile },
    { ...input, revisionId: null },
  ]) {
    const result = await handler.export(invalid);
    assert.equal(result.isError, true);
  }
  assert.equal(preflightCalls, 0);
  assert.equal(gatewayCalls, 0);
  assert.equal(publicationCalls, 0);
});

test('unsupported local export fails before any gateway/network operation', async () => {
  let gatewayCalls = 0;
  const gateway = {
    exportBoard: async () => {
      gatewayCalls += 1;
      return { connected: false };
    },
  } as unknown as ProtectedBoardGatewayV1;
  const local = {
    preflight: () => ({
      ok: false,
      error: {
        code: 'LOCAL_EXPORT_UNAVAILABLE',
        message: 'Secure local export is unavailable on this platform',
        retryable: false,
        details: null,
      },
    }),
  } as unknown as LocalExportFileV1;
  const result = await new ExportToolHandlersV1(gateway, local).export(input);
  assert.equal(gatewayCalls, 0);
  assert.deepEqual((structured(result).error as { value: unknown }).value, {
    code: 'LOCAL_EXPORT_UNAVAILABLE',
    message: 'Secure local export is unavailable on this platform',
    retryable: false,
    details: null,
  });
});

test('remote export code and retryability pass through before the writer opens', async () => {
  let publishes = 0;
  const gateway = {
    exportBoard: async () => ({
      connected: true,
      value: {
        ok: false,
        source: 'board',
        error: {
          code: 'EXPORT_RATE_LIMITED',
          message: 'Export capacity is temporarily unavailable',
          retryable: true,
        },
      },
    }),
  } as unknown as ProtectedBoardGatewayV1;
  const local = {
    preflight: () => ({
      ok: true,
      value: {
        format: 'pdf',
        components: ['workspace', '.tmp', 'agent', 'synthetic.pdf'],
        normalizedPathBytes: input.outputFile.length,
        displayName: 'synthetic.pdf',
        helperHandle: { descriptor: 5, released: false },
      },
    }),
    release: () => undefined,
    publish: async () => {
      publishes += 1;
      throw new Error('must not publish');
    },
  } as unknown as LocalExportFileV1;
  const result = await new ExportToolHandlersV1(gateway, local).export(input);
  assert.equal(publishes, 0);
  assert.deepEqual(structured(result).error as { source: string; value: unknown }, {
    source: 'board',
    value: {
      code: 'EXPORT_RATE_LIMITED',
      message: 'Export capacity is temporarily unavailable',
      retryable: true,
    },
  });
});

test('success returns only format, byte count and basename-safe display', async () => {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(Buffer.from('%PDF-', 'ascii'));
      controller.close();
    },
  });
  const gateway = {
    exportBoard: async (request: {
      publish: (
        artifact: {
          format: 'pdf';
          contentType: string;
          contentLength: number;
          body: ReadableStream<Uint8Array>;
        },
        signal: AbortSignal,
      ) => Promise<unknown>;
    }) => ({
      connected: true,
      value: await request.publish(
        { format: 'pdf', contentType: 'application/pdf', contentLength: 5, body },
        new AbortController().signal,
      ),
    }),
  } as unknown as ProtectedBoardGatewayV1;
  const local = {
    preflight: () => ({
      ok: true,
      value: {
        format: 'pdf',
        components: ['workspace', '.tmp', 'agent', 'synthetic.pdf'],
        normalizedPathBytes: input.outputFile.length,
        displayName: 'synthetic.pdf',
        helperHandle: { descriptor: 5, released: false },
      },
    }),
    release: () => undefined,
    publish: async () => ({
      ok: true,
      value: { format: 'pdf', bytes: 5, fileName: 'synthetic.pdf' },
    }),
  } as unknown as LocalExportFileV1;
  const result = await new ExportToolHandlersV1(gateway, local).export(input);
  assert.deepEqual(structured(result).result, {
    format: 'pdf',
    bytes: 5,
    fileName: 'synthetic.pdf',
  });
  assert.equal(JSON.stringify(structured(result)).includes('/workspace/'), false);
  const schema = toolOutputSchemaV1('board_export', BOARD_TOOL_ERROR_CODES_V1.board_export);
  assert.equal(schema.safeParse(structured(result)).success, true);
  assert.equal(
    schema.safeParse({
      ...structured(result),
      result: { format: 'pdf', bytes: 5, fileName: '/private/synthetic.pdf' },
    }).success,
    false,
  );
});

const exportFailures = [
  ['EXPORT_INVALID_REQUEST', 400, false, 'Invalid export request'],
  ['EXPORT_UNAUTHENTICATED', 401, false, 'Authentication is required'],
  ['EXPORT_FORBIDDEN', 403, false, 'Export is not allowed'],
  ['EXPORT_NOT_FOUND', 404, false, 'Board or revision not found'],
  ['EXPORT_REQUIRED_CONTENT_UNSUPPORTED', 422, false, 'Required content cannot be exported'],
  ['EXPORT_BOUNDS_EXCEEDED', 413, false, 'Export bounds exceeded'],
  ['EXPORT_RATE_LIMITED', 429, true, 'Export capacity is temporarily unavailable'],
  ['EXPORT_RENDERER_UNAVAILABLE', 503, true, 'Export renderer is unavailable'],
  ['EXPORT_RENDER_TIMEOUT', 504, true, 'Export timed out'],
  ['EXPORT_ENCODE_FAILED', 500, true, 'Export encoding failed'],
  ['EXPORT_INTERNAL_ERROR', 500, true, 'Export failed'],
] as const;

const connectionResponse = (
  requestId: string,
  scopes: readonly string[] = ['export:read'],
  boardId = 'board_synthetic',
): Response =>
  new Response(
    JSON.stringify({
      principal: {
        principalKind: 'service',
        principalId: 'key_synthetic',
        grantId: null,
      },
      credential: {
        keyPublicId: 'key_synthetic',
        scopes,
        status: 'active',
        expiresAt: '2027-07-30T00:00:00.000Z',
      },
      selectedBoard: {
        board: {
          boardId,
          title: 'Synthetic',
          createdAt: '2026-07-16T15:00:00.000Z',
          updatedAt: '2026-07-16T16:00:00.000Z',
          archivedAt: null,
          headRevision: {
            revisionId: 'revision_1',
            revisionNumber: 1,
            createdAt: '2026-07-16T16:00:00.000Z',
          },
        },
        capabilities: {
          protocolVersion: 1,
          type: 'board.capabilities',
          schemaVersion: '1.0.0',
          compatibilityMode: 'frozen-major',
          supported: {
            nodeTypes: [...NODE_TYPES_V1],
            commandTypes: [...BOARD_MUTATION_COMMAND_TYPES_V1],
            operationTypes: [...BOARD_OPERATION_TYPES_V1],
            eventTypes: [...BOARD_EVENT_TYPES_V1],
            hitlKinds: [...HITL_KINDS_V1],
            artifactRequestCapabilities: [...ARTIFACT_REQUEST_CAPABILITIES_V1],
          },
          limits: { ...BOARD_LIMITS_V1 },
          grantedCapabilities: [],
          allowedArtifactRequestCapabilities: [],
        },
      },
      versions: { mcpServer: '0.0.0', boardProtocol: '1.0.0', api: 'v1' },
    }),
    {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store, private',
        Pragma: 'no-cache',
        Vary: 'Origin, Cookie, Authorization',
        'X-Request-Id': requestId,
      },
    },
  );

const gateway = (fetchImplementation: typeof fetch): ProtectedBoardGatewayV1 =>
  new ProtectedBoardGatewayV1({
    baseUrl: 'http://127.0.0.1:3411',
    fetch: fetchImplementation,
    timeoutMs: 30_000,
    credentialMode: 'api_key',
    tokens: {
      snapshot: async () => ({
        version: 1,
        accessToken: apiKey,
        generation: 'api-key',
      }),
      invalidate: async () => undefined,
    } as TokenProviderV1,
    logger: { log() {} },
  });

test('gateway enforces the literal union for dynamic history and read-modify-write plans', async () => {
  const exercise = async (
    scopes: readonly string[],
    toolName: 'board_scene_get' | 'board_scene_patch',
    operations: readonly ['history.get'] | readonly ['board.get', 'scene.replace'],
  ) => {
    let networkCalls = 0;
    const client = gateway(async (request) => {
      const url = new URL(request instanceof Request ? request.url : request);
      assert.equal(url.pathname, '/api/v1/mcp/connection');
      const boardId = url.searchParams.get('boardId') ?? '';
      const operation = operations.at(-1) ?? '';
      assert.equal(url.searchParams.get('authorizationOperation'), operation);
      return connectionResponse(url.searchParams.get('requestId') ?? '', scopes, boardId);
    });
    const result = await client.call(
      toolName,
      operations,
      {
        signal: undefined,
        authorization: {
          boardId: 'board_synthetic',
          operation: operations.at(-1)!,
        },
      },
      async () => {
        networkCalls += 1;
        return { ok: true as const };
      },
    );
    return { result, networkCalls };
  };

  assert.equal(
    (await exercise(['history:read'], 'board_scene_get', ['history.get'])).networkCalls,
    1,
  );
  assert.equal(
    (await exercise(['board:read'], 'board_scene_get', ['history.get'])).networkCalls,
    0,
  );
  assert.equal(
    (
      await exercise(['board:read', 'board:write'], 'board_scene_patch', [
        'board.get',
        'scene.replace',
      ])
    ).networkCalls,
    1,
  );
  assert.equal(
    (await exercise(['board:write'], 'board_scene_patch', ['board.get', 'scene.replace']))
      .networkCalls,
    0,
  );
});

test('gateway preserves all eleven exact export failure tuples', async () => {
  for (const [code, status, retryable, message] of exportFailures) {
    const client = gateway(async (request) => {
      const url = new URL(request instanceof Request ? request.url : request);
      if (url.pathname === '/api/v1/mcp/connection')
        return connectionResponse(
          url.searchParams.get('requestId') ?? '',
          ['export:read'],
          url.searchParams.get('boardId') ?? '',
        );
      assert.equal(url.pathname, '/api/v1/boards/board_synthetic/exports');
      return new Response(JSON.stringify({ ok: false, error: { code, message, retryable } }), {
        status,
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
      });
    });
    const result = await client.exportBoard({
      boardId: 'board_synthetic',
      revisionId: null,
      format: 'pdf',
      publish: async () => {
        throw new Error('must not publish a failed export');
      },
    });
    assert.equal(result.connected, true);
    if (!result.connected) continue;
    assert.deepEqual(result.value, {
      ok: false,
      source: 'board',
      error: { code, message, retryable },
    });
  }
});

test('gateway validates binary content type and declared size without buffering success', async () => {
  const bytes = Buffer.from('%PDF-', 'ascii');
  const client = gateway(async (request, init) => {
    const url = new URL(request instanceof Request ? request.url : request);
    if (url.pathname === '/api/v1/mcp/connection')
      return connectionResponse(
        url.searchParams.get('requestId') ?? '',
        ['export:read'],
        url.searchParams.get('boardId') ?? '',
      );
    assert.equal(init?.method, 'POST');
    assert.deepEqual(JSON.parse(String(init?.body)), { format: 'pdf', revisionId: null });
    return new Response(bytes, {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Length': String(bytes.byteLength),
      },
    });
  });
  const result = await client.exportBoard({
    boardId: 'board_synthetic',
    revisionId: null,
    format: 'pdf',
    publish: async (artifact) => ({
      ok: true,
      value: {
        format: artifact.format,
        bytes: Buffer.from(await new Response(artifact.body).arrayBuffer()).byteLength,
        fileName: 'synthetic.pdf',
      },
    }),
  });
  assert.equal(result.connected, true);
  if (!result.connected || !result.value.ok) return;
  assert.deepEqual(result.value.value, {
    format: 'pdf',
    bytes: bytes.byteLength,
    fileName: 'synthetic.pdf',
  });
});
