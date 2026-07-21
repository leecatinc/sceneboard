import assert from 'node:assert/strict';
import test from 'node:test';

import type { BoardSdkHttpClient } from '@sceneboard/board-sdk/http';

import { ArtifactToolHandlersV1 } from '../../src/tools/artifact.tools.js';
import { InteractionToolHandlersV1 } from '../../src/tools/interaction.tools.js';
import type { ProtectedBoardGatewayV1 } from '../../src/tools/protected-board.gateway.js';

const cancelled = {
  ok: false as const,
  error: { code: 'CANCELLED' as const, retryable: false as const },
};

test('six delegated descriptors map exact D7/D8 requests without aliases or optimistic state', async () => {
  const calls: Array<{ method: string; request: unknown }> = [];
  const client = {
    getArtifact: async (request: unknown) => {
      calls.push({ method: 'getArtifact', request });
      return cancelled;
    },
    putArtifact: async (requestId: unknown, source: unknown) => {
      calls.push({ method: 'putArtifact', request: { requestId, source } });
      return cancelled;
    },
    mutateBoard: async (request: { command?: { type?: string } }) => {
      calls.push({ method: `mutateBoard:${request.command?.type}`, request });
      return cancelled;
    },
    getInteraction: async (request: unknown) => {
      calls.push({ method: 'getInteraction', request });
      return cancelled;
    },
  } as unknown as BoardSdkHttpClient;
  const gateway = {
    call: async <T>(operation: (value: BoardSdkHttpClient) => Promise<T>) => ({
      connected: true as const,
      value: await operation(client),
    }),
  } as unknown as ProtectedBoardGatewayV1;
  const artifacts = new ArtifactToolHandlersV1(gateway);
  const interactions = new InteractionToolHandlersV1(gateway);
  const signal = new AbortController().signal;

  await artifacts.get(
    { boardId: 'board_1', artifactId: 'artifact_1', versionId: 'version_1' },
    signal,
  );
  await artifacts.put(
    {
      boardId: 'board_1',
      expectedRevisionId: 'revision_1',
      idempotencyKey: 'idempotency-key-1',
      artifactId: null,
      html: '<main>SceneBoard</main>',
      css: null,
      javascript: null,
      requestedCapabilities: ['clipboard.write'],
    },
    signal,
  );
  await artifacts.stop(
    {
      boardId: 'board_1',
      expectedRevisionId: 'revision_1',
      idempotencyKey: 'idempotency-key-2',
      artifactId: 'artifact_1',
      versionId: 'version_1',
      reason: 'Stop the demo',
    },
    signal,
  );
  await interactions.request(
    {
      boardId: 'board_1',
      expectedRevisionId: 'revision_1',
      idempotencyKey: 'idempotency-key-3',
      hitlRequestId: 'hitl_1',
      definition: {
        kind: 'info',
        title: 'Review',
        body: 'Please review.',
        acknowledgeLabel: 'Done',
      },
    },
    signal,
  );
  await interactions.status(
    {
      boardId: 'board_1',
      hitlRequestId: 'hitl_1',
      wait: { afterStateUpdatedAt: '2026-07-16T00:00:00.000Z', timeoutMs: 25_000 },
    },
    signal,
  );
  await interactions.respond(
    {
      boardId: 'board_1',
      expectedRevisionId: 'revision_1',
      idempotencyKey: 'idempotency-key-4',
      hitlRequestId: 'hitl_1',
      response: { kind: 'info', acknowledged: true },
    },
    signal,
  );

  assert.deepEqual(
    calls.map((call) => call.method),
    [
      'getArtifact',
      'putArtifact',
      'mutateBoard:artifact.stop',
      'mutateBoard:hitl.request',
      'getInteraction',
      'mutateBoard:hitl.respond',
    ],
  );
  const put = calls[1]?.request as {
    source: { requestedCapabilities: string[]; artifactId: null };
  };
  assert.deepEqual(put.source.requestedCapabilities, ['clipboard.write']);
  assert.equal(put.source.artifactId, null);
  const wait = calls[4]?.request as { wait: { timeoutMs: number; afterStateUpdatedAt: string } };
  assert.deepEqual(wait.wait, {
    afterStateUpdatedAt: '2026-07-16T00:00:00.000Z',
    timeoutMs: 25_000,
  });
});

test('artifact capabilities are strict sorted unique and malformed input dispatches nothing', async () => {
  let calls = 0;
  const gateway = {
    call: async () => {
      calls += 1;
      return { connected: false as const };
    },
  } as unknown as ProtectedBoardGatewayV1;
  const result = await new ArtifactToolHandlersV1(gateway).put({
    boardId: 'board_1',
    expectedRevisionId: 'revision_1',
    idempotencyKey: 'idempotency-key-1',
    artifactId: null,
    html: '',
    css: null,
    javascript: null,
    requestedCapabilities: ['network.fetch', 'clipboard.write'],
  });
  assert.equal(result.isError, true);
  assert.equal(calls, 0);
  const error = (result.structuredContent as { error: { value: { code: string } } }).error.value;
  assert.equal(error.code, 'BOARD_MCP_INPUT_INVALID');
});
