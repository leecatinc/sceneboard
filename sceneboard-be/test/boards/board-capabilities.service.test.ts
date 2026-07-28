import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { BoardId, GrantId, PrincipalId, RequestId } from '@sceneboard/board-schema';

import type { BoardAccessPolicy } from '../../src/grants/board-access.policy.js';
import { BoardCapabilitiesService } from '../../src/boards/board-capabilities.service.js';
import { currentBoardSessionAccessFromContext } from '../../src/grants/current-board-capabilities.js';

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
  assert.deepEqual(result.result.sessionAccess, {
    protocolVersion: 1,
    type: 'board.session.access',
    capabilityEpoch: 0,
    authorizationCapabilities: [],
    connectionGrantCeiling: { scopes: [], lifecyclePermissions: [] },
  });
  assert.deepEqual(calls, [
    {
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
    },
  ]);
});

test('projects exact owner, editor, and viewer browser authorization ceilings', () => {
  const actor = {
    principalKind: 'user' as const,
    principalId: 'principal_1' as PrincipalId,
    grantId: null,
    scopes: [
      'artifact.control',
      'artifact.publish',
      'board.history.read',
      'board.hitl.request',
      'board.hitl.respond',
      'board.read',
      'board.write',
    ] as const,
  };
  const membership = (membershipRole: 'owner' | 'editor' | 'viewer') => ({
    boardPk: 1n,
    accountPk: 1n,
    membershipPk: 1n,
    membershipRole,
    membershipVersion: 1,
    capabilityEpoch: 7,
    capabilityEpochEnforced: true,
    operation: 'capabilities.get' as const,
    surface: 'browser' as const,
    write: false,
  });
  const owner = currentBoardSessionAccessFromContext({
    actor: { ...actor, scopes: [...actor.scopes] },
    membership: membership('owner'),
  });
  const editor = currentBoardSessionAccessFromContext({
    actor: { ...actor, scopes: [...actor.scopes] },
    membership: membership('editor'),
  });
  const viewer = currentBoardSessionAccessFromContext({
    actor: { ...actor, scopes: [...actor.scopes] },
    membership: membership('viewer'),
  });

  assert.equal(owner.authorizationCapabilities.includes('board.admin'), true);
  assert.equal(owner.authorizationCapabilities.includes('board.members.manage'), true);
  assert.deepEqual(owner.connectionGrantCeiling.lifecyclePermissions, [
    'board.archive',
    'board.create',
  ]);
  assert.equal(editor.authorizationCapabilities.includes('connection.manage.own'), true);
  assert.equal(editor.authorizationCapabilities.includes('board.admin'), false);
  assert.deepEqual(editor.connectionGrantCeiling.lifecyclePermissions, []);
  assert.deepEqual(viewer.authorizationCapabilities, ['board.read']);
  assert.deepEqual(viewer.connectionGrantCeiling.scopes, []);
});
