import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import test from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { createBoardMcpServerV1 } from '../../src/server.js';
import { BOARD_TOOL_NAMES_V1 } from '../../src/tools/register-tools.js';

const TOKEN = `lcbg_v1.${'a'.repeat(22)}.${'b'.repeat(43)}`;
const OPEN_AT = '2026-07-16T00:00:00.000Z';
const ANSWERED_AT = '2026-07-16T00:01:00.000Z';
const EXPIRES_AT = '2026-07-16T00:15:00.000Z';

type ToolOutput = {
  ok: boolean;
  tool: string;
  requestId: string;
  result: {
    requestId: string;
    result: Record<string, unknown>;
  };
  metadata: unknown;
};

const structured = (value: Awaited<ReturnType<Client['callTool']>>): ToolOutput => (
  value.structuredContent as ToolOutput
);

test('terminal MCP drives artifact and blocking-first HITL flows through the real SDK HTTP boundary', { timeout: 5_000 }, async () => {
  const definition = {
    kind: 'info' as const,
    title: 'Review SceneBoard output',
    body: 'Confirm that the generated scene is ready.',
    acknowledgeLabel: 'Looks good',
  };
  let interaction = {
    hitlRequestId: 'hitl_1',
    definition,
    state: 'open' as 'open' | 'answered',
    createdAt: OPEN_AT,
    expiresAt: EXPIRES_AT,
    stateUpdatedAt: OPEN_AT,
    response: null as null | { kind: 'info'; acknowledged: true },
    answeredAt: null as string | null,
  };
  let artifactStatus: 'ready' | 'stopped' = 'ready';
  let waitStartedResolve: (() => void) | null = null;
  let answerRecordedResolve: (() => void) | null = null;
  const waitStarted = new Promise<void>((resolve) => { waitStartedResolve = resolve; });
  const answerRecorded = new Promise<void>((resolve) => { answerRecordedResolve = resolve; });
  const requests: Array<{ method: string; path: string }> = [];

  const success = (requestId: string, result: Record<string, unknown>): Response => new Response(JSON.stringify({
    protocolVersion: 1,
    type: 'board.http.success',
    requestId,
    result,
    metadata: { history: null },
  }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'X-Request-Id': requestId,
    },
  });

  const fetchFixture: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const method = init?.method ?? 'GET';
    requests.push({ method, path: url.pathname });
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('authorization'), `Bearer ${TOKEN}`);
    const body = init?.body === undefined
      ? null
      : JSON.parse(new TextDecoder().decode(init.body as Uint8Array)) as Record<string, unknown>;
    const requestId = url.searchParams.get('requestId')
      ?? headers.get('x-request-id')
      ?? String(body?.requestId ?? '');
    assert.match(requestId, /^[A-Za-z0-9_-]{22}$/u);

    if (method === 'POST' && url.pathname === '/api/v1/boards/board_1/artifacts') {
      assert.deepEqual(Object.keys(body ?? {}), [
        'boardId', 'expectedRevisionId', 'idempotencyKey', 'artifactId',
        'html', 'css', 'javascript', 'requestedCapabilities',
      ]);
      assert.deepEqual(body, {
        boardId: 'board_1',
        expectedRevisionId: 'revision_1',
        idempotencyKey: 'idempotency-key-artifact',
        artifactId: null,
        html: '<main>SceneBoard terminal acceptance</main>',
        css: null,
        javascript: null,
        requestedCapabilities: [],
      });
      artifactStatus = 'ready';
      return success(requestId, {
        protocolVersion: 1,
        type: 'mutation.result',
        requestId,
        boardId: 'board_1',
        replayed: false,
        eventIds: [],
        result: {
          type: 'artifact.publish',
          artifact: {
            artifact: { artifactId: 'artifact_1', versionId: 'version_1' },
            status: artifactStatus,
            updatedAt: OPEN_AT,
            failure: null,
          },
        },
      });
    }

    if (method === 'GET' && url.pathname === '/api/v1/boards/board_1/artifacts/artifact_1/versions/version_1') {
      return success(requestId, {
        protocolVersion: 1,
        type: 'board.operation.result',
        requestId,
        replayed: false,
        result: {
          type: 'artifact.get',
          manifest: {
            protocolVersion: 1,
            type: 'artifact.manifest',
            artifact: { artifactId: 'artifact_1', versionId: 'version_1' },
            entryPath: 'index.html',
            resources: [{
              path: 'index.html',
              mediaType: 'text/html',
              sha256: 'a'.repeat(64),
              byteLength: 12,
            }],
            requestedCapabilities: [],
          },
          runtime: {
            artifact: { artifactId: 'artifact_1', versionId: 'version_1' },
            status: artifactStatus,
            updatedAt: OPEN_AT,
            failure: null,
          },
        },
      });
    }

    if (method === 'GET' && url.pathname === '/api/v1/boards/board_1/interactions/hitl_1') {
      assert.equal(url.searchParams.get('afterStateUpdatedAt'), OPEN_AT);
      assert.equal(url.searchParams.get('timeoutMs'), '25000');
      waitStartedResolve?.();
      await answerRecorded;
      return success(requestId, {
        protocolVersion: 1,
        type: 'board.operation.result',
        requestId,
        replayed: false,
        result: { type: 'hitl.read', changed: true, hitl: interaction },
      });
    }

    if (method === 'POST' && url.pathname === '/api/v1/boards/board_1/mutations') {
      assert.ok(body !== null && typeof body.command === 'object' && body.command !== null);
      const command = body.command as Record<string, unknown>;
      if (command.type === 'hitl.request') {
        assert.deepEqual(command.request, definition);
        return success(requestId, {
          protocolVersion: 1,
          type: 'mutation.result',
          requestId,
          boardId: 'board_1',
          replayed: false,
          eventIds: [],
          result: { type: 'hitl.request', hitl: interaction },
        });
      }
      if (command.type === 'hitl.respond') {
        assert.deepEqual(command.response, { kind: 'info', acknowledged: true });
        interaction = {
          ...interaction,
          state: 'answered',
          stateUpdatedAt: ANSWERED_AT,
          response: { kind: 'info', acknowledged: true },
          answeredAt: ANSWERED_AT,
        };
        answerRecordedResolve?.();
        return success(requestId, {
          protocolVersion: 1,
          type: 'mutation.result',
          requestId,
          boardId: 'board_1',
          replayed: false,
          eventIds: [],
          result: { type: 'hitl.respond', hitl: interaction },
        });
      }
      if (command.type === 'artifact.stop') {
        artifactStatus = 'stopped';
        return success(requestId, {
          protocolVersion: 1,
          type: 'mutation.result',
          requestId,
          boardId: 'board_1',
          replayed: false,
          eventIds: [],
          result: {
            type: 'artifact.stop',
            artifact: {
              artifact: { artifactId: 'artifact_1', versionId: 'version_1' },
              status: artifactStatus,
              updatedAt: ANSWERED_AT,
              failure: null,
            },
          },
        });
      }
    }

    throw new TypeError(`unexpected SceneBoard acceptance route: ${method} ${url.pathname}`);
  };

  const runtime = await createBoardMcpServerV1({
    argv: [],
    cwd: await mkdtemp(`${tmpdir()}/sceneboard-terminal-e2e-`),
    env: {
      BOARD_API_URL: 'http://127.0.0.1:3411',
      LEECAT_BOARD_ACCESS_TOKEN: TOKEN,
    },
    fetch: fetchFixture,
    probeOnStart: false,
    stderr: () => undefined,
  });
  runtime.registry.setProtectedEnabled(true);
  const client = new Client({ name: 'SceneBoard terminal acceptance', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await runtime.connect(serverTransport);
  await client.connect(clientTransport);

  try {
    assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name), [...BOARD_TOOL_NAMES_V1]);

    const artifactPut = await client.callTool({
      name: 'board_artifact_put',
      arguments: {
        boardId: 'board_1',
        expectedRevisionId: 'revision_1',
        idempotencyKey: 'idempotency-key-artifact',
        artifactId: null,
        html: '<main>SceneBoard terminal acceptance</main>',
        css: null,
        javascript: null,
        requestedCapabilities: [],
      },
    });
    assert.equal(
      artifactPut.isError,
      false,
      `artifact publish failed: ${JSON.stringify(artifactPut.structuredContent)}`,
    );
    assert.equal(structured(artifactPut).result.result.type, 'artifact.publish');

    const artifactGet = await client.callTool({
      name: 'board_artifact_get',
      arguments: { boardId: 'board_1', artifactId: 'artifact_1', versionId: 'version_1' },
    });
    assert.equal(artifactGet.isError, false);
    assert.equal(structured(artifactGet).result.result.type, 'artifact.get');

    const interactionRequest = await client.callTool({
      name: 'board_interaction_request',
      arguments: {
        boardId: 'board_1',
        expectedRevisionId: 'revision_1',
        idempotencyKey: 'idempotency-key-hitl-request',
        hitlRequestId: 'hitl_1',
        definition,
      },
    });
    assert.equal(interactionRequest.isError, false);
    assert.equal(structured(interactionRequest).result.result.type, 'hitl.request');

    const interactionStatusPromise = client.callTool({
      name: 'board_interaction_status',
      arguments: {
        boardId: 'board_1',
        hitlRequestId: 'hitl_1',
        wait: { afterStateUpdatedAt: OPEN_AT, timeoutMs: 25_000 },
      },
    });
    await waitStarted;
    const interactionRespond = await client.callTool({
      name: 'board_interaction_respond',
      arguments: {
        boardId: 'board_1',
        expectedRevisionId: 'revision_1',
        idempotencyKey: 'idempotency-key-hitl-response',
        hitlRequestId: 'hitl_1',
        response: { kind: 'info', acknowledged: true },
      },
    });
    const interactionStatus = await interactionStatusPromise;
    assert.equal(interactionRespond.isError, false);
    assert.equal(interactionStatus.isError, false);
    assert.equal(structured(interactionRespond).result.result.type, 'hitl.respond');
    assert.deepEqual(structured(interactionStatus).result.result, {
      type: 'hitl.read',
      changed: true,
      hitl: interaction,
    });

    const artifactStop = await client.callTool({
      name: 'board_artifact_stop',
      arguments: {
        boardId: 'board_1',
        expectedRevisionId: 'revision_1',
        idempotencyKey: 'idempotency-key-artifact-stop',
        artifactId: 'artifact_1',
        versionId: 'version_1',
        reason: 'Stop the accepted artifact',
      },
    });
    assert.equal(artifactStop.isError, false);
    assert.equal((structured(artifactStop).result.result.artifact as { status: string }).status, 'stopped');

    const serializedOutputs = JSON.stringify([
      artifactPut,
      artifactGet,
      interactionRequest,
      interactionRespond,
      interactionStatus,
      artifactStop,
    ]);
    assert.equal(serializedOutputs.includes(TOKEN), false);
    assert.equal(serializedOutputs.includes('<main>SceneBoard terminal acceptance</main>'), false);
    assert.deepEqual(requests, [
      { method: 'POST', path: '/api/v1/boards/board_1/artifacts' },
      { method: 'GET', path: '/api/v1/boards/board_1/artifacts/artifact_1/versions/version_1' },
      { method: 'POST', path: '/api/v1/boards/board_1/mutations' },
      { method: 'GET', path: '/api/v1/boards/board_1/interactions/hitl_1' },
      { method: 'POST', path: '/api/v1/boards/board_1/mutations' },
      { method: 'POST', path: '/api/v1/boards/board_1/mutations' },
    ]);
  } finally {
    await client.close();
    await runtime.close();
  }
});
