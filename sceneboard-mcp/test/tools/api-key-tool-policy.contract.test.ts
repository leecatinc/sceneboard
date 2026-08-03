import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ARTIFACT_REQUEST_CAPABILITIES_V1,
  BOARD_EVENT_TYPES_V1,
  BOARD_LIMITS_V1,
  BOARD_MUTATION_COMMAND_TYPES_V1,
  BOARD_OPERATION_TYPES_V1,
  HITL_KINDS_V1,
  NODE_TYPES_V1,
} from '@sceneboard/board-schema';

import { ACCOUNT_API_KEY_TOOL_POLICIES_V1 } from '../../src/tools/account-api-key-tool-policy.js';
import { BoardToolHandlersV1 } from '../../src/tools/board.tools.js';
import { DocumentToolHandlersV2 } from '../../src/tools/document.tools.js';
import { ExportToolHandlersV1 } from '../../src/tools/export.tools.js';
import { HistoryToolHandlersV1 } from '../../src/tools/history.tools.js';
import { ProtectedBoardGatewayV1 } from '../../src/tools/protected-board.gateway.js';
import {
  API_KEY_TOOL_NAMES_V1,
  BOARD_TOOL_ERROR_CODES_V1,
} from '../../src/tools/register-tools.js';
import { SceneToolHandlersV1 } from '../../src/tools/scene.tools.js';
import { toolOutputSchemaV1 } from '../../src/tools/tool-result.js';

const expected = {
  board_list: { operationPlans: [{ operations: ['board.list'], scopes: ['board:read'] }] },
  board_get: { operationPlans: [{ operations: ['board.get'], scopes: ['board:read'] }] },
  board_scene_get: {
    operationPlans: [
      { operations: ['board.get'], scopes: ['board:read'] },
      { operations: ['history.get'], scopes: ['history:read'] },
    ],
  },
  board_document_get: {
    operationPlans: [
      { operations: ['board.get'], scopes: ['board:read'] },
      { operations: ['history.get'], scopes: ['history:read'] },
    ],
  },
  board_create: { operationPlans: [{ operations: ['board.create'], scopes: ['board:create'] }] },
  board_rename: { operationPlans: [{ operations: ['board.rename'], scopes: ['board:write'] }] },
  board_archive: {
    operationPlans: [{ operations: ['board.archive'], scopes: ['board:archive'] }],
  },
  board_capabilities_get: {
    operationPlans: [{ operations: ['capabilities.get'], scopes: ['board:read'] }],
  },
  board_scene_replace: {
    operationPlans: [{ operations: ['scene.replace'], scopes: ['board:write'] }],
  },
  board_scene_patch: {
    operationPlans: [
      { operations: ['board.get', 'scene.replace'], scopes: ['board:read', 'board:write'] },
    ],
  },
  board_scene_clear: {
    operationPlans: [{ operations: ['scene.clear'], scopes: ['board:write'] }],
  },
  board_document_replace: {
    operationPlans: [
      {
        operations: ['board.get', 'document.replace'],
        scopes: ['board:read', 'board:write'],
      },
    ],
  },
  board_page_add: {
    operationPlans: [
      {
        operations: ['board.get', 'document.replace'],
        scopes: ['board:read', 'board:write'],
      },
    ],
  },
  board_page_remove: {
    operationPlans: [
      {
        operations: ['board.get', 'document.replace'],
        scopes: ['board:read', 'board:write'],
      },
    ],
  },
  board_page_reorder: {
    operationPlans: [
      {
        operations: ['board.get', 'document.replace'],
        scopes: ['board:read', 'board:write'],
      },
    ],
  },
  board_page_update: {
    operationPlans: [
      {
        operations: ['board.get', 'document.replace'],
        scopes: ['board:read', 'board:write'],
      },
    ],
  },
  board_page_default_set: {
    operationPlans: [
      {
        operations: ['board.get', 'document.replace'],
        scopes: ['board:read', 'board:write'],
      },
    ],
  },
  board_history_list: {
    operationPlans: [{ operations: ['history.list'], scopes: ['history:read'] }],
  },
  board_history_get: {
    operationPlans: [{ operations: ['history.get'], scopes: ['history:read'] }],
  },
  board_history_restore: {
    operationPlans: [{ operations: ['scene.restore'], scopes: ['board:write', 'history:read'] }],
  },
  board_export: {
    operationPlans: [{ operations: ['export.render'], scopes: ['export:read'] }],
  },
};

test('MCP API-key policy exactly matches the backend owner-tool contract', () => {
  assert.deepEqual(ACCOUNT_API_KEY_TOOL_POLICIES_V1, expected);
  assert.deepEqual(API_KEY_TOOL_NAMES_V1.slice(1).sort(), Object.keys(expected).sort());
  assert.equal(API_KEY_TOOL_NAMES_V1.includes('board_pair_request' as never), false);
  assert.equal(API_KEY_TOOL_NAMES_V1.includes('sceneboard_media_place' as never), false);
});

test('every board-scoped handler supplies its exact board and authorization operation', async () => {
  const calls: Array<{ tool: string; operations: unknown; authorization: unknown }> = [];
  const gateway = {
    call: async (...args: unknown[]) => {
      calls.push({
        tool: args[0] as string,
        operations: args[1],
        authorization: (args[2] as { authorization?: unknown }).authorization,
      });
      return { connected: false as const };
    },
    renameBoard: async () => ({ connected: false as const }),
  };
  const boards = new BoardToolHandlersV1(gateway as never);
  const scenes = new SceneToolHandlersV1(gateway as never);
  const documents = new DocumentToolHandlersV2(gateway as never);
  const history = new HistoryToolHandlersV1(gateway as never);
  const baseMutation = {
    boardId: 'board_1',
    expectedRevisionId: 'revision_1',
    idempotencyKey: 'idempotency-key-1',
  };

  await boards.list({ cursor: null, limit: 1, includeArchived: false });
  await boards.get({ boardId: 'board_1' });
  await boards.create({ title: 'Board', idempotencyKey: 'idempotency-key-1' });
  await boards.archive({ boardId: 'board_1', confirm: true, idempotencyKey: 'idempotency-key-1' });
  await boards.capabilities({ boardId: 'board_1' });
  await scenes.get({ boardId: 'board_1', revisionId: null });
  await scenes.get({ boardId: 'board_1', revisionId: 'revision_1' });
  await scenes.replace({
    ...baseMutation,
    scene: { protocolVersion: 1, type: 'scene', root: null },
  });
  await scenes.patch({ ...baseMutation, operations: [{ type: 'replace_root', root: null }] });
  await scenes.clear(baseMutation);
  await documents.get({ boardId: 'board_1', revisionId: null });
  await documents.get({ boardId: 'board_1', revisionId: 'revision_1' });
  await documents.replace({ ...baseMutation, document: {} });
  await documents.add({ ...baseMutation, page: {}, index: 0 });
  await documents.remove({ ...baseMutation, pageId: 'page_1' });
  await documents.reorder({ ...baseMutation, pageId: 'page_1', toIndex: 0 });
  await documents.update({ ...baseMutation, pageId: 'page_1', title: 'Page' });
  await documents.defaultSet({ ...baseMutation, pageId: 'page_1' });
  await history.list({ boardId: 'board_1', cursor: null, limit: 1 });
  await history.get({ boardId: 'board_1', revisionId: 'revision_1' });
  await history.restore({
    ...baseMutation,
    revisionId: 'revision_0',
    confirm: true,
  });

  assert.deepEqual(calls, [
    { tool: 'board_list', operations: 'board.list', authorization: undefined },
    {
      tool: 'board_get',
      operations: 'board.get',
      authorization: { boardId: 'board_1', operation: 'board.get' },
    },
    { tool: 'board_create', operations: 'board.create', authorization: undefined },
    {
      tool: 'board_archive',
      operations: 'board.archive',
      authorization: { boardId: 'board_1', operation: 'board.archive' },
    },
    {
      tool: 'board_capabilities_get',
      operations: 'capabilities.get',
      authorization: { boardId: 'board_1', operation: 'capabilities.get' },
    },
    {
      tool: 'board_scene_get',
      operations: ['board.get'],
      authorization: { boardId: 'board_1', operation: 'board.get' },
    },
    {
      tool: 'board_scene_get',
      operations: ['history.get'],
      authorization: { boardId: 'board_1', operation: 'history.get' },
    },
    {
      tool: 'board_scene_replace',
      operations: 'scene.replace',
      authorization: { boardId: 'board_1', operation: 'scene.replace' },
    },
    {
      tool: 'board_scene_patch',
      operations: ['board.get', 'scene.replace'],
      authorization: { boardId: 'board_1', operation: 'scene.replace' },
    },
    {
      tool: 'board_scene_clear',
      operations: 'scene.clear',
      authorization: { boardId: 'board_1', operation: 'scene.clear' },
    },
    {
      tool: 'board_document_get',
      operations: ['board.get'],
      authorization: { boardId: 'board_1', operation: 'board.get' },
    },
    {
      tool: 'board_document_get',
      operations: ['history.get'],
      authorization: { boardId: 'board_1', operation: 'history.get' },
    },
    ...[
      'board_document_replace',
      'board_page_add',
      'board_page_remove',
      'board_page_reorder',
      'board_page_update',
      'board_page_default_set',
    ].map((tool) => ({
      tool,
      operations: ['board.get', 'document.replace'],
      authorization: { boardId: 'board_1', operation: 'document.replace' },
    })),
    {
      tool: 'board_history_list',
      operations: 'history.list',
      authorization: { boardId: 'board_1', operation: 'history.list' },
    },
    {
      tool: 'board_history_get',
      operations: 'history.get',
      authorization: { boardId: 'board_1', operation: 'history.get' },
    },
    {
      tool: 'board_history_restore',
      operations: 'scene.restore',
      authorization: { boardId: 'board_1', operation: 'scene.restore' },
    },
  ]);
});

const apiKey = `sbk_v1.${'A'.repeat(22)}.${'B'.repeat(43)}`;

const gatewayForPreflight = (
  response: (requestId: string, url: URL) => Response,
  onInvalidate: () => void = () => undefined,
) =>
  new ProtectedBoardGatewayV1({
    baseUrl: 'http://127.0.0.1:3411',
    fetch: async (input) => {
      const url = new URL(String(input));
      assert.equal(url.pathname, '/api/v1/mcp/connection');
      return response(url.searchParams.get('requestId') ?? '', url);
    },
    timeoutMs: 30_000,
    tokens: {
      snapshot: async () => ({ version: 1, generation: 'generation_1', accessToken: apiKey }),
      invalidate: async () => onInvalidate(),
    },
    logger: { log() {} },
    credentialMode: 'api_key',
    now: () => Date.parse('2026-08-02T00:00:00.000Z'),
  });

const connectionHeaders = (requestId: string): Record<string, string> => ({
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store, private',
  Pragma: 'no-cache',
  Vary: 'Origin, Cookie, Authorization',
  'X-Request-Id': requestId,
});

test('export preflight maps insufficient scope and terminal authentication into export errors', async () => {
  let invalidations = 0;
  let publications = 0;
  const insufficient = gatewayForPreflight((requestId, url) => {
    assert.equal(url.searchParams.get('boardId'), 'board_1');
    assert.equal(url.searchParams.get('authorizationOperation'), 'export.render');
    return new Response(
      JSON.stringify({
        error: {
          protocolVersion: 1,
          type: 'board.error',
          code: 'FORBIDDEN',
          message: 'Forbidden',
          category: 'auth',
          retryable: false,
          httpStatusHint: 403,
          details: null,
        },
      }),
      { status: 403, headers: connectionHeaders(requestId) },
    );
  });
  const forbidden = await insufficient.exportBoard({
    boardId: 'board_1',
    revisionId: null,
    format: 'pdf',
    publish: async () => {
      publications += 1;
      throw new Error('must not publish');
    },
  });
  assert.equal(forbidden.connected, true);
  if (forbidden.connected) {
    assert.equal(forbidden.value.ok, false);
    if (!forbidden.value.ok) {
      assert.equal(forbidden.value.source, 'board');
      assert.equal(forbidden.value.error.code, 'EXPORT_FORBIDDEN');
    }
  }

  const unauthorized = gatewayForPreflight(
    (requestId, url) => {
      assert.equal(url.searchParams.get('boardId'), 'board_1');
      assert.equal(url.searchParams.get('authorizationOperation'), 'export.render');
      return new Response(
        JSON.stringify({
          error: {
            protocolVersion: 1,
            type: 'board.error',
            code: 'UNAUTHENTICATED',
            message: 'Authentication is required',
            category: 'auth',
            retryable: false,
            httpStatusHint: 401,
            details: null,
          },
        }),
        { status: 401, headers: connectionHeaders(requestId) },
      );
    },
    () => {
      invalidations += 1;
    },
  );
  const unauthenticated = await unauthorized.exportBoard({
    boardId: 'board_1',
    revisionId: null,
    format: 'pdf',
    publish: async () => {
      publications += 1;
      throw new Error('must not publish');
    },
  });
  assert.equal(unauthenticated.connected, true);
  if (unauthenticated.connected) {
    assert.equal(unauthenticated.value.ok, false);
    if (!unauthenticated.value.ok) {
      assert.equal(unauthenticated.value.source, 'board');
      assert.equal(unauthenticated.value.error.code, 'EXPORT_UNAUTHENTICATED');
    }
  }
  assert.equal(invalidations, 1);
  assert.equal(publications, 0);
});

test('export preflight maps every endpoint failure to an exact schema-valid export error', async () => {
  const cases = [
    {
      board: {
        code: 'UNAUTHENTICATED',
        message: 'Authentication is required',
        category: 'auth',
        retryable: false,
        httpStatusHint: 401,
        details: null,
      },
      expected: {
        code: 'EXPORT_UNAUTHENTICATED',
        message: 'Authentication is required',
        retryable: false,
      },
      invalidates: true,
    },
    {
      board: {
        code: 'FORBIDDEN',
        message: 'Forbidden',
        category: 'auth',
        retryable: false,
        httpStatusHint: 403,
        details: null,
      },
      expected: {
        code: 'EXPORT_FORBIDDEN',
        message: 'Export is not allowed',
        retryable: false,
      },
      invalidates: false,
    },
    {
      board: {
        code: 'BOARD_NOT_FOUND',
        message: 'Board not found',
        category: 'not_found',
        retryable: false,
        httpStatusHint: 404,
        details: null,
      },
      expected: {
        code: 'EXPORT_NOT_FOUND',
        message: 'Board or revision not found',
        retryable: false,
      },
      invalidates: false,
    },
    {
      board: {
        code: 'RATE_LIMITED',
        message: 'Rate limited',
        category: 'rate_limit',
        retryable: true,
        httpStatusHint: 429,
        details: { retryAfterSeconds: 1 },
      },
      expected: {
        code: 'EXPORT_RATE_LIMITED',
        message: 'Export capacity is temporarily unavailable',
        retryable: true,
      },
      invalidates: false,
    },
    {
      board: {
        code: 'SERVICE_UNAVAILABLE',
        message: 'Service unavailable',
        category: 'availability',
        retryable: true,
        httpStatusHint: 503,
        details: { retryAfterSeconds: null },
      },
      expected: {
        code: 'EXPORT_RENDERER_UNAVAILABLE',
        message: 'Export renderer is unavailable',
        retryable: true,
      },
      invalidates: false,
    },
    {
      board: {
        code: 'INTERNAL_ERROR',
        message: 'Internal error',
        category: 'internal',
        retryable: false,
        httpStatusHint: 500,
        details: null,
      },
      expected: {
        code: 'EXPORT_INTERNAL_ERROR',
        message: 'Export failed',
        retryable: true,
      },
      invalidates: false,
    },
  ] as const;
  const outputSchema = toolOutputSchemaV1('board_export', BOARD_TOOL_ERROR_CODES_V1.board_export);

  for (const fixture of cases) {
    let fetchCalls = 0;
    let invalidations = 0;
    let publications = 0;
    let releases = 0;
    const gateway = gatewayForPreflight(
      (requestId, url) => {
        fetchCalls += 1;
        assert.equal(url.searchParams.get('boardId'), 'board_1');
        assert.equal(url.searchParams.get('authorizationOperation'), 'export.render');
        return new Response(
          JSON.stringify({
            error: {
              protocolVersion: 1,
              type: 'board.error',
              ...fixture.board,
            },
          }),
          { status: fixture.board.httpStatusHint, headers: connectionHeaders(requestId) },
        );
      },
      () => {
        invalidations += 1;
      },
    );
    const handler = new ExportToolHandlersV1(gateway, {
      preflight: () => ({ ok: true, value: { reservation: 'test' } }),
      publish: async () => {
        publications += 1;
        throw new Error('must not publish');
      },
      release: () => {
        releases += 1;
      },
    } as never);

    const handled = await handler.export({
      boardId: 'board_1',
      revisionId: 'revision_1',
      format: 'pdf',
      outputFile: '/tmp/sceneboard-export-not-written.pdf',
    });
    assert.equal(handled.isError, true);
    const structured = handled.structuredContent as {
      error: { source: string; value: Record<string, unknown> };
    };
    assert.equal(structured.error.source, 'board');
    assert.deepEqual(structured.error.value, fixture.expected);
    assert.equal(outputSchema.safeParse(handled.structuredContent).success, true);
    assert.equal(fetchCalls, 1);
    assert.equal(invalidations, fixture.invalidates ? 1 : 0);
    assert.equal(publications, 0);
    assert.equal(releases, 1);
  }
});

test('API-key gateway preflight rejects wrong-family, mismatched-ID, and expired projections', async () => {
  const apiKeyProjection = (
    expiresAt: string,
    principalId = 'key_1',
    boardId: string | null = null,
  ) => ({
    principal: { principalKind: 'service', principalId, grantId: null },
    credential: {
      keyPublicId: 'key_1',
      scopes: ['board:read'],
      status: 'active',
      expiresAt,
    },
    selectedBoard:
      boardId === null
        ? null
        : {
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
  });
  const pairingProjection = {
    principal: { principalKind: 'mcp_client', principalId: 'client_1', grantId: 'grant_1' },
    grant: {
      grantId: 'grant_1',
      client: {
        clientId: 'client_1',
        clientName: 'SceneBoard Codex',
        installationFingerprint: 'abcdefghijklmnop',
      },
      scopes: ['board.read'],
      lifecyclePermissions: [],
      boardIds: ['board_1'],
      lifetime: 'persistent',
      status: 'active',
      activatedAt: '2026-07-16T16:00:00.000Z',
      expiresAt: '2026-08-16T16:00:00.000Z',
    },
    selectedBoard: null,
    versions: { mcpServer: '0.0.0', boardProtocol: '1.0.0', api: 'v1' },
  };
  for (const projection of [
    pairingProjection,
    apiKeyProjection('2026-08-01T23:59:59.999Z'),
    apiKeyProjection('2026-08-02T00:00:00.000Z'),
  ]) {
    let operations = 0;
    const gateway = gatewayForPreflight(
      (requestId) =>
        new Response(JSON.stringify(projection), {
          status: 200,
          headers: connectionHeaders(requestId),
        }),
    );
    const result = await gateway.call('board_list', 'board.list', async () => {
      operations += 1;
      return { ok: true };
    });
    assert.equal(result.connected, false);
    assert.equal(operations, 0);
  }

  let targetedOperations = 0;
  const mismatched = gatewayForPreflight((requestId, url) => {
    assert.equal(url.searchParams.get('boardId'), 'board_1');
    assert.equal(url.searchParams.get('authorizationOperation'), 'board.get');
    return new Response(
      JSON.stringify(apiKeyProjection('2026-08-02T00:00:00.001Z', 'key_other', 'board_1')),
      { status: 200, headers: connectionHeaders(requestId) },
    );
  });
  const mismatchedResult = await mismatched.call(
    'board_get',
    'board.get',
    {
      signal: undefined,
      authorization: { boardId: 'board_1', operation: 'board.get' },
    },
    async () => {
      targetedOperations += 1;
      return { ok: true };
    },
  );
  assert.equal(mismatchedResult.connected, false);
  assert.equal(targetedOperations, 0);

  let futureOperations = 0;
  const future = gatewayForPreflight(
    (requestId) =>
      new Response(JSON.stringify(apiKeyProjection('2026-08-02T00:00:00.001Z')), {
        status: 200,
        headers: connectionHeaders(requestId),
      }),
  );
  const accepted = await future.call('board_list', 'board.list', async () => {
    futureOperations += 1;
    return { ok: true };
  });
  assert.equal(accepted.connected, true);
  assert.equal(futureOperations, 1);
});
