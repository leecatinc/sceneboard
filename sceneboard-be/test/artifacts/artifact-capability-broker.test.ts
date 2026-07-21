import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ArtifactCapabilityBrokerService } from '../../src/artifacts/artifact-capability-broker.service.js';
import { parseArtifactNetworkFetchRequestV1 } from '../../src/artifacts/artifact-network.dto.js';
import { ArtifactController } from '../../src/artifacts/artifact.controller.js';
import { ArtifactBrokerError } from '../../src/common/errors/artifact-broker.error.js';
import { BoardContractError } from '../../src/common/errors/app-error.js';

const request = parseArtifactNetworkFetchRequestV1({
  protocolVersion: 1,
  type: 'artifact.network.fetch.request',
  requestId: 'AAAAAAAAAAAAAAAAAAAAAA',
  method: 'GET',
  url: 'https://example.com/data.json',
});

test('keeps network fetch default-denied after current authorization and exact-pair certification', async () => {
  const calls: string[] = [];
  const policy = {
    withAuthorizedBoardTransaction: async (
      _input: unknown,
      apply: (connection: never, context: never) => Promise<unknown>,
    ) => {
      calls.push('authorized');
      return apply(
        {} as never,
        {
          artifactCapabilityPolicy: {
            allowedArtifactRequestCapabilities: ['network.fetch'],
            policyEpoch: 'epoch',
          },
        } as never,
      );
    },
  };
  const artifacts = {
    readVersion: async () => {
      calls.push('artifact');
      return {
        boardPk: '1',
        versionPk: '2',
        lastEventSequence: 3,
        runtime: { status: 'ready' },
        manifest: { requestedCapabilities: ['network.fetch'] },
      };
    },
  };
  const broker = new ArtifactCapabilityBrokerService(
    policy as never,
    artifacts as never,
    { write: async () => undefined } as never,
  );
  await assert.rejects(
    broker.networkFetch({
      principal: {} as never,
      boardId: 'board_1' as never,
      artifact: { artifactId: 'artifact_1', versionId: 'version_1' } as never,
      request,
    }),
    (error: unknown) => error instanceof ArtifactBrokerError && error.code === 'POLICY_DENIED',
  );
  assert.deepEqual(calls, ['authorized', 'artifact']);
});

test('rejects malformed, credentialed, non-HTTPS, and fragmented broker requests without I/O', async () => {
  assert.throws(
    () =>
      parseArtifactNetworkFetchRequestV1({
        ...request,
        method: 'POST',
      }),
    ArtifactBrokerError,
  );
  let authorizationCalls = 0;
  const broker = new ArtifactCapabilityBrokerService(
    {
      withAuthorizedBoardTransaction: async () => {
        authorizationCalls += 1;
      },
    } as never,
    {} as never,
    { write: async () => undefined } as never,
  );
  for (const url of [
    'http://example.com/data',
    'https://user:pass@example.com/data',
    'https://example.com:444/data',
    'https://example.com/data#fragment',
  ]) {
    await assert.rejects(
      broker.networkFetch({
        principal: {} as never,
        boardId: 'board_1' as never,
        artifact: { artifactId: 'artifact_1', versionId: 'version_1' } as never,
        request: { ...request, url },
      }),
      ArtifactBrokerError,
    );
  }
  assert.equal(authorizationCalls, 0);
});

test('package transport rejects an MCP principal before reading package bytes', async () => {
  let packageReads = 0;
  const controller = new ArtifactController(
    {
      getPackage: async () => {
        packageReads += 1;
        return Buffer.alloc(0);
      },
    } as never,
    {} as never,
    {
      resolveUser: () => {
        throw new Error('not a browser session');
      },
    } as never,
  );
  await assert.rejects(
    controller.getPackage(
      {
        headers: { authorization: 'Bearer hidden' },
        boardPrincipal: { kind: 'mcp' },
      } as never,
      'board_1',
      'artifact_1',
      'version_1',
      {},
      {} as never,
    ),
    (error: unknown) =>
      error instanceof BoardContractError && error.boardError.code === 'FORBIDDEN',
  );
  assert.equal(packageReads, 0);
});
