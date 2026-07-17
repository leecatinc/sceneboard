import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  ArtifactApplicationPortV1,
  ArtifactApplicationService,
  BoardArtifactPutSourceV1Parser,
  CurrentArtifactRuntimeSummaryProvider,
} from '../../src/artifacts/index.js';
import { ArtifactController } from '../../src/artifacts/artifact.controller.js';
import { D1_PARSED_BODY } from '../../src/common/http/strict-json-body.middleware.js';
import { CurrentArtifactRuntimeSummaryPort } from '../../src/snapshots/ports/current-artifact-runtime-summary.port.js';

test('publishes one finalized D7 application barrel without MCP or UI ownership', () => {
  assert.equal(typeof ArtifactApplicationPortV1, 'function');
  assert.equal(typeof ArtifactApplicationService, 'function');
  assert.equal(typeof BoardArtifactPutSourceV1Parser.parse, 'function');
  assert.equal(CurrentArtifactRuntimeSummaryProvider.prototype instanceof CurrentArtifactRuntimeSummaryPort, true);
});

test('artifact publish admits the MCP correlation header without changing the finalized source DTO', async () => {
  let admittedRequestId = '';
  const controller = new ArtifactController({
    publish: async (input: { requestId: string }) => {
      admittedRequestId = input.requestId;
      return {
        protocolVersion: 1,
        type: 'mutation.result',
        requestId: input.requestId,
        boardId: 'board_1',
        replayed: false,
        eventIds: [],
        result: { type: 'artifact.publish', artifact: {} },
      } as never;
    },
  } as never, {} as never, {} as never);
  const response = await controller.publish({
    headers: { 'x-request-id': 'request_1' },
    boardPrincipal: {
      kind: 'mcp',
      actor: { principalKind: 'mcp_client', principalId: 'client_1', grantId: 'grant_1', scopes: [] },
    },
    [D1_PARSED_BODY]: {
      boardId: 'board_1',
      expectedRevisionId: 'revision_1',
      idempotencyKey: 'idempotency-key-1',
      artifactId: null,
      html: '<main>SceneBoard</main>',
      css: null,
      javascript: null,
      requestedCapabilities: [],
    },
  } as never, 'board_1');
  assert.equal(admittedRequestId, 'request_1');
  assert.equal(response.requestId, 'request_1');
});
