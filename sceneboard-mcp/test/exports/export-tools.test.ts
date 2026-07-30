import assert from 'node:assert/strict';
import test from 'node:test';

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import type { TokenProviderV1 } from '../../src/credentials/token-provider.js';
import type { LocalExportFileV1 } from '../../src/exports/local-export-file.js';
import { ExportToolHandlersV1 } from '../../src/tools/export.tools.js';
import { ProtectedBoardGatewayV1 } from '../../src/tools/protected-board.gateway.js';
import { toolOutputSchemaV1 } from '../../src/tools/tool-result.js';
import { BOARD_TOOL_ERROR_CODES_V1 } from '../../src/tools/register-tools.js';

const apiKey = `sbk_v1.${'A'.repeat(22)}.${'B'.repeat(43)}`;
const input = {
  boardId: 'board_synthetic',
  revisionId: null,
  format: 'pdf' as const,
  outputFile: '/tmp/sceneboard-export/synthetic.pdf',
};

const structured = (result: CallToolResult): Record<string, unknown> =>
  result.structuredContent as Record<string, unknown>;

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
    exportBoard: async () => ({
      connected: true,
      value: {
        ok: true,
        value: {
          format: 'pdf',
          contentType: 'application/pdf',
          contentLength: 5,
          body,
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

const connectionResponse = (requestId: string): Response =>
  new Response(
    JSON.stringify({
      principal: {
        principalKind: 'service',
        principalId: 'service_synthetic',
        grantId: null,
      },
      credential: {
        keyPublicId: 'key_synthetic',
        scopes: ['export:read'],
        status: 'active',
        expiresAt: '2027-07-30T00:00:00.000Z',
      },
      selectedBoard: null,
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

test('gateway preserves all eleven exact export failure tuples', async () => {
  for (const [code, status, retryable, message] of exportFailures) {
    const client = gateway(async (request) => {
      const url = new URL(request instanceof Request ? request.url : request);
      if (url.pathname === '/api/v1/mcp/connection')
        return connectionResponse(url.searchParams.get('requestId') ?? '');
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
      return connectionResponse(url.searchParams.get('requestId') ?? '');
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
  });
  assert.equal(result.connected, true);
  if (!result.connected || !result.value.ok) return;
  assert.equal(result.value.value.contentLength, bytes.byteLength);
  assert.equal(result.value.value.contentType, 'application/pdf');
  assert.deepEqual(Buffer.from(await new Response(result.value.value.body).arrayBuffer()), bytes);
});
