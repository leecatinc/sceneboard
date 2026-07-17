import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { BoardId, GrantId, PrincipalId, RequestId } from '@leecat-board/board-schema';

import type { BoardAccessPolicy } from '../../src/grants/board-access.policy.js';
import { BoardCapabilitiesService } from '../../src/boards/board-capabilities.service.js';

test('projects current authorized capabilities in one repeatable-read board cut', async () => {
  const boardId = 'board_1' as BoardId;
  const grantId = 'grant_1' as GrantId;
  const principalId = 'principal_1' as PrincipalId;
  const requestId = 'request_01' as RequestId;
  const calls: unknown[] = [];
  const accessPolicy: BoardAccessPolicy = {
    withAuthorizedBoardTransaction: async (input, apply) => {
      calls.push(input);
      return apply({} as never, {
        actor: {
          principalKind: 'mcp_client',
          principalId,
          grantId,
          scopes: ['board.read'],
        },
        ownerUserPk: 1n,
        access: { kind: 'grant', grantPk: 2n, grantId },
        createBinding: null,
        artifactCapabilityPolicy: {
          allowedArtifactRequestCapabilities: ['download'],
          policyEpoch: 'epoch',
        },
      });
    },
  };
  const result = await new BoardCapabilitiesService(accessPolicy).get({
    principal: {
      kind: 'mcp',
      actor: {
        principalKind: 'mcp_client',
        principalId,
        grantId,
        scopes: ['board.read'],
      },
      ownerUserPk: 1n,
      grantPk: 2n,
      credentialPk: 3n,
      grantId,
      sourceFamilyPublicId: null,
    },
    requestId,
    boardId,
  });
  assert.equal(result.result.type, 'capabilities.get');
  if (result.result.type !== 'capabilities.get') assert.fail('unexpected operation result');
  assert.deepEqual(result.result.capabilities.grantedCapabilities, ['board.read']);
  assert.deepEqual(result.result.capabilities.allowedArtifactRequestCapabilities, ['download']);
  assert.deepEqual(calls, [{
    principal: {
      kind: 'mcp',
      actor: {
        principalKind: 'mcp_client',
        principalId,
        grantId,
        scopes: ['board.read'],
      },
      ownerUserPk: 1n,
      grantPk: 2n,
      credentialPk: 3n,
      grantId,
      sourceFamilyPublicId: null,
    },
    operation: 'capabilities.get',
    boardId,
    isolation: 'REPEATABLE_READ_CUT',
  }]);
});
