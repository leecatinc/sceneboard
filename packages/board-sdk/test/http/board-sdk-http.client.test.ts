import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  BoardOperationRequestParserV1,
  DEFAULT_BOARD_CAPABILITIES_V2,
  adaptLegacySceneToDocumentV2,
  type ArtifactReferenceV1,
  type BoardErrorV1,
  type BoardId,
  type HistoryEntryV1,
  type MutationResultV1,
  type BoardOperationRequestV1,
  type BoardOperationResultV1,
  type RequestId,
  type MutationRequestV2,
  type MutationResultV2,
} from '@sceneboard/board-schema';

import {
  BoardSdkHttpClient,
  parseBoardHttpResultV1,
  type BoardSdkHttpLogEventV1,
} from '../../src/http/index.js';

const fixtureRoot = new URL('../../../board-schema/test/fixtures/valid/', import.meta.url);
const TOKEN = `lcbg_v1.${'a'.repeat(22)}.${'b'.repeat(43)}`;
const encoder = new TextEncoder();

const fixture = <T>(name: string): T =>
  JSON.parse(readFileSync(new URL(name, fixtureRoot), 'utf8')) as T;

const operationRequest = <const K extends BoardOperationRequestV1['type']>(
  name: string,
  type: K,
): BoardOperationRequestV1 & { type: K } => {
  const parsed = BoardOperationRequestParserV1.parse(fixture(name));
  assert.equal(parsed.ok, true);
  if (!parsed.ok || parsed.data.value.type !== type) throw new Error('fixture mismatch');
  return parsed.data.value as unknown as BoardOperationRequestV1 & { type: K };
};

const successResponse = (
  result: BoardOperationResultV1,
  metadata: unknown = { history: null },
): Response =>
  new Response(
    JSON.stringify({
      protocolVersion: 1,
      type: 'board.http.success',
      requestId: result.requestId,
      result,
      metadata,
    }),
    {
      status: result.result.type === 'board.create' && !result.replayed ? 201 : 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'X-Request-Id': result.requestId,
      },
    },
  );

const client = (fetchValue: typeof fetch, logs: BoardSdkHttpLogEventV1[] = [], timeoutMs = 2_000) =>
  new BoardSdkHttpClient({
    baseUrl: 'https://sceneboard.dev',
    fetch: fetchValue,
    bearerTokenProvider: () => TOKEN,
    timeoutPolicy: { timeoutMs },
    logger: { log: (event) => logs.push(event) },
  });

test('sends a closed Bearer GET with exact query fields and parses the shared success envelope', async () => {
  const request = operationRequest('operation-request-board-list.v1.json', 'board.list');
  const result = fixture<BoardOperationResultV1>('operation-result-board-list.v1.json');
  const logs: BoardSdkHttpLogEventV1[] = [];
  let calls = 0;
  const fetchValue: typeof fetch = async (input, init) => {
    calls += 1;
    const url = new URL(input instanceof Request ? input.url : input.toString());
    assert.equal(url.origin, 'https://sceneboard.dev');
    assert.equal(url.pathname, '/api/v1/boards');
    assert.equal(url.search, '?requestId=request_1&limit=10&includeArchived=false');
    assert.equal(init?.method, 'GET');
    assert.equal(init?.body, undefined);
    assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${TOKEN}`);
    assert.equal(init?.redirect, 'manual');
    return successResponse(result);
  };

  const response = await client(fetchValue, logs).listBoards(request);
  assert.equal(response.ok, true);
  if (response.ok) {
    assert.equal(response.result.result.type, 'board.list');
    assert.equal(response.metadata.history, null);
  }
  assert.equal(calls, 1);
  assert.deepEqual(
    logs.map(({ route, attempt, resultCode }) => ({ route, attempt, resultCode })),
    [
      {
        route: '/api/v1/boards',
        attempt: 1,
        resultCode: 'board.list',
      },
    ],
  );
});

test('artifact put preserves the finalized eight-key D7 source body and request correlation', async () => {
  const result = fixture<MutationResultV1>('mutation-result-artifact-publish.v1.json');
  const fetchValue: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    assert.equal(url.pathname, '/api/v1/boards/board_1/artifacts');
    assert.equal(url.search, '');
    assert.equal(init?.method, 'POST');
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('authorization'), `Bearer ${TOKEN}`);
    assert.equal(headers.get('x-request-id'), 'request_1');
    const body = JSON.parse(new TextDecoder().decode(init?.body as ArrayBuffer)) as Record<
      string,
      unknown
    >;
    assert.deepEqual(Object.keys(body), [
      'boardId',
      'expectedRevisionId',
      'idempotencyKey',
      'artifactId',
      'html',
      'css',
      'javascript',
      'requestedCapabilities',
    ]);
    assert.deepEqual(body, {
      boardId: 'board_1',
      expectedRevisionId: 'revision_1',
      idempotencyKey: 'idempotency-key-1',
      artifactId: null,
      html: '<main>SceneBoard</main>',
      css: null,
      javascript: null,
      requestedCapabilities: [],
    });
    return new Response(
      JSON.stringify({
        protocolVersion: 1,
        type: 'board.http.success',
        requestId: result.requestId,
        result,
        metadata: { history: null },
      }),
      {
        status: 200,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'X-Request-Id': result.requestId,
        },
      },
    );
  };
  const response = await client(fetchValue).putArtifact('request_1' as RequestId, {
    boardId: 'board_1' as BoardId,
    expectedRevisionId: 'revision_1' as never,
    idempotencyKey: 'idempotency-key-1' as never,
    artifactId: null,
    html: '<main>SceneBoard</main>',
    css: null,
    javascript: null,
    requestedCapabilities: [],
  });
  assert.equal(response.ok, true);
  if (response.ok) assert.equal(response.result.result.type, 'artifact.publish');
});

test('document mutation binds the V2 media profile, 201/200 replay status, and nested result', async () => {
  const document = fixture<MutationRequestV2['command'] & { type: 'document.replace' }>(
    'document-basic.v2.json',
  );
  const request = {
    protocolVersion: 1,
    requestId: 'request_1',
    idempotencyKey: 'idempotency-key-1',
    boardId: 'board_1',
    expectedRevisionId: 'revision_1',
    command: { type: 'document.replace', document },
  } as unknown as MutationRequestV2 & {
    command: Extract<MutationRequestV2['command'], { type: 'document.replace' }>;
  };
  const responseResult = {
    protocolVersion: 1,
    type: 'mutation.result',
    requestId: request.requestId,
    boardId: request.boardId,
    replayed: false,
    eventIds: [],
    result: {
      type: 'document.replace',
      revision: {
        revisionId: 'revision_2',
        revisionNumber: 2,
        createdAt: '2026-07-16T00:01:00.000Z',
      },
      originType: 'document.replace',
      sourceRevisionId: null,
      document,
    },
  } as unknown as MutationResultV2;
  const fetchValue: typeof fetch = async (input, init) => {
    assert.equal(new URL(input.toString()).pathname, '/api/v1/boards/board_1/mutations');
    assert.equal(
      new Headers(init?.headers).get('content-type'),
      'application/vnd.sceneboard.document+json;version=2',
    );
    assert.deepEqual(JSON.parse(new TextDecoder().decode(init?.body as ArrayBuffer)), request);
    return new Response(
      JSON.stringify({
        protocolVersion: 1,
        type: 'board.http.success',
        requestId: request.requestId,
        result: responseResult,
        metadata: { history: null },
      }),
      {
        status: 201,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'X-Request-Id': request.requestId,
        },
      },
    );
  };
  const result = await client(fetchValue).mutateDocument(request);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.result.result.type, 'document.replace');
    assert.deepEqual(result.result.result.document, document);
  }
});

test('document read uses the 32 MiB parser profile and preserves the snapshot branch', async () => {
  const request = operationRequest('operation-request-board-get.v1.json', 'board.get');
  const responseResult = fixture<BoardOperationResultV1>('operation-result-board-get.v1.json');
  assert.equal(responseResult.result.type, 'board.get');
  if (responseResult.result.type !== 'board.get') return;
  const legacy = responseResult.result.snapshot;
  assert.equal('scene' in legacy, true);
  if (!('scene' in legacy)) return;
  const documentResult: BoardOperationResultV1 = {
    ...responseResult,
    result: {
      ...responseResult.result,
      snapshot: {
        ...legacy,
        document: adaptLegacySceneToDocumentV2({
          boardId: legacy.boardId,
          scene: legacy.scene,
        }),
        capabilities: {
          ...DEFAULT_BOARD_CAPABILITIES_V2,
          supported: {
            nodeTypes: [...DEFAULT_BOARD_CAPABILITIES_V2.supported.nodeTypes],
            commandTypes: [...DEFAULT_BOARD_CAPABILITIES_V2.supported.commandTypes],
            operationTypes: [...DEFAULT_BOARD_CAPABILITIES_V2.supported.operationTypes],
            eventTypes: [...DEFAULT_BOARD_CAPABILITIES_V2.supported.eventTypes],
            hitlKinds: [...DEFAULT_BOARD_CAPABILITIES_V2.supported.hitlKinds],
            artifactRequestCapabilities: [
              ...DEFAULT_BOARD_CAPABILITIES_V2.supported.artifactRequestCapabilities,
            ],
          },
          limits: { ...DEFAULT_BOARD_CAPABILITIES_V2.limits },
          grantedCapabilities: [...legacy.capabilities.grantedCapabilities],
          allowedArtifactRequestCapabilities: [
            ...legacy.capabilities.allowedArtifactRequestCapabilities,
          ],
        },
        scene: undefined,
      } as never,
    },
  };
  delete (documentResult.result.snapshot as unknown as { scene?: unknown }).scene;
  const fetchValue: typeof fetch = async (_input, init) => {
    assert.equal(new Headers(init?.headers).has('content-type'), false);
    return successResponse(documentResult);
  };
  const result = await client(fetchValue).getDocumentBoard(request);
  assert.equal(result.ok, true);
  if (result.ok && result.result.result.type === 'board.get')
    assert.equal('document' in result.result.result.snapshot, true);
});

test('preserves an exact D1 error and never retries a terminal authorization result', async () => {
  const request = operationRequest('operation-request-board-list.v1.json', 'board.list');
  const error = fixture<BoardErrorV1>('error-forbidden.v1.json');
  let calls = 0;
  const fetchValue: typeof fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({ error }), {
      status: 403,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'X-Request-Id': request.requestId,
      },
    });
  };
  assert.deepEqual(await client(fetchValue).listBoards(request), { ok: false, error });
  assert.equal(calls, 1);
});

test('retries a read transport reset without changing request identity', async () => {
  const request = operationRequest('operation-request-board-list.v1.json', 'board.list');
  const result = fixture<BoardOperationResultV1>('operation-result-board-list.v1.json');
  const seen: string[] = [];
  const fetchValue: typeof fetch = async (input) => {
    seen.push(input.toString());
    if (seen.length === 1) throw new TypeError('connection reset');
    return successResponse(result);
  };
  const response = await client(fetchValue).listBoards(request);
  assert.equal(response.ok, true);
  assert.equal(seen.length, 2);
  assert.equal(seen[0], seen[1]);
});

test('rejects response body overflow from Content-Length before parsing', async () => {
  const request = operationRequest('operation-request-board-list.v1.json', 'board.list');
  const fetchValue: typeof fetch = async () =>
    new Response('{}', {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': '2097153',
        'X-Request-Id': request.requestId,
      },
    });
  assert.deepEqual(await client(fetchValue).listBoards(request), {
    ok: false,
    error: { code: 'RESPONSE_INVALID', retryable: false, reason: 'body_too_large' },
  });
});

test('rejects pre-cancelled calls without credential access or dispatch', async () => {
  const request = operationRequest('operation-request-board-list.v1.json', 'board.list');
  let calls = 0;
  const fetchValue: typeof fetch = async () => {
    calls += 1;
    throw new Error('must not run');
  };
  const controller = new AbortController();
  controller.abort();
  assert.deepEqual(await client(fetchValue).listBoards(request, controller.signal), {
    ok: false,
    error: { code: 'CANCELLED', retryable: false },
  });
  assert.equal(calls, 0);
});

test('transport-neutral parser rejects duplicate outer members and request correlation drift', () => {
  const result = fixture<BoardOperationResultV1>('operation-result-board-list.v1.json');
  const requestId = result.requestId as RequestId;
  const duplicate = encoder.encode(
    `{"protocolVersion":1,"protocolVersion":1,"type":"board.http.success","requestId":"request_1","result":{},"metadata":{"history":null}}`,
  );
  assert.deepEqual(
    parseBoardHttpResultV1(duplicate, {
      status: 200,
      requestId,
      resultType: 'board.list',
    }),
    { ok: false, reason: 'duplicate_member' },
  );

  const drifted = encoder.encode(
    JSON.stringify({
      protocolVersion: 1,
      type: 'board.http.success',
      requestId: 'request_other',
      result,
      metadata: { history: null },
    }),
  );
  assert.deepEqual(
    parseBoardHttpResultV1(drifted, {
      status: 200,
      requestId,
      resultType: 'board.list',
    }),
    { ok: false, reason: 'schema' },
  );
});

test('history success requires metadata aligned to the exact ordered revision entries', () => {
  const result = fixture<BoardOperationResultV1>('operation-result-history-list.v1.json');
  assert.equal(result.result.type, 'history.list');
  if (result.result.type !== 'history.list') return;
  const history = {
    protocolVersion: 1,
    type: 'history.adapter-metadata',
    entries: result.result.entries.map((entry: HistoryEntryV1) => ({
      revisionId: entry.revision.revisionId,
      label: `Revision ${entry.revision.revisionNumber}`,
    })),
    navigation: null,
  };
  const bytes = encoder.encode(
    JSON.stringify({
      protocolVersion: 1,
      type: 'board.http.success',
      requestId: result.requestId,
      result,
      metadata: { history },
    }),
  );
  const parsed = parseBoardHttpResultV1(bytes, {
    status: 200,
    requestId: result.requestId,
    resultType: 'history.list',
    boardId: 'board_1' as BoardId,
  });
  assert.equal(parsed.ok, true);
  if (parsed.ok) assert.equal(parsed.value.ok, true);

  history.entries[0] = {
    ...history.entries[0],
    revisionId: 'revision_other' as (typeof history.entries)[number]['revisionId'],
  };
  const reversed = encoder.encode(
    JSON.stringify({
      protocolVersion: 1,
      type: 'board.http.success',
      requestId: result.requestId,
      result,
      metadata: { history },
    }),
  );
  assert.deepEqual(
    parseBoardHttpResultV1(reversed, {
      status: 200,
      requestId: result.requestId,
      resultType: 'history.list',
    }),
    { ok: false, reason: 'correlation' },
  );
});

test('artifact success correlates the exact immutable artifact/version pair', () => {
  const result = fixture<BoardOperationResultV1>('operation-result-artifact-get.v1.json');
  assert.equal(result.result.type, 'artifact.get');
  if (result.result.type !== 'artifact.get') return;
  const bytes = encoder.encode(
    JSON.stringify({
      protocolVersion: 1,
      type: 'board.http.success',
      requestId: result.requestId,
      result,
      metadata: { history: null },
    }),
  );
  assert.equal(
    parseBoardHttpResultV1(bytes, {
      status: 200,
      requestId: result.requestId,
      resultType: 'artifact.get',
      boardId: 'board_1' as BoardId,
      artifact: result.result.manifest.artifact,
    }).ok,
    true,
  );
  assert.deepEqual(
    parseBoardHttpResultV1(bytes, {
      status: 200,
      requestId: result.requestId,
      resultType: 'artifact.get',
      artifact: { artifactId: 'artifact_1', versionId: 'version_other' } as ArtifactReferenceV1,
    }),
    { ok: false, reason: 'correlation' },
  );
});
