import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  BoardCapabilitiesParserV1,
  BoardCapabilitiesParserV2,
  BoardCapabilitiesParserV3,
  MAX_ARTIFACT_REFERENCE_OCCURRENCES,
  type BoardId,
  type GrantId,
  type PrincipalId,
  type RequestId,
} from '@sceneboard/board-schema';

import type { BoardAccessPolicy } from '../../src/grants/board-access.policy.js';
import { BoardCapabilitiesService } from '../../src/boards/board-capabilities.service.js';
import {
  currentBoardCapabilitiesFromContext,
  currentBoardSessionAccessFromContext,
} from '../../src/grants/current-board-capabilities.js';

const authorizedContext = {
  actor: {
    principalKind: 'mcp_client' as const,
    principalId: 'principal_1' as PrincipalId,
    grantId: 'grant_1' as GrantId,
    scopes: ['board.read' as const],
  },
  artifactCapabilityPolicy: {
    allowedArtifactRequestCapabilities: ['download' as const],
    policyEpoch: 'epoch',
  },
};

test('projects frozen V1/V2 and occurrence-aware V3 capability selectors', () => {
  const v1 = currentBoardCapabilitiesFromContext(authorizedContext, 1);
  const v2 = currentBoardCapabilitiesFromContext(authorizedContext, 2);
  const v3 = currentBoardCapabilitiesFromContext(authorizedContext, 3);

  assert.equal(BoardCapabilitiesParserV1.parse(v1).ok, true);
  assert.equal(BoardCapabilitiesParserV2.parse(v2).ok, true);
  assert.equal(BoardCapabilitiesParserV3.parse(v3).ok, true);
  assert.equal(v1.schemaVersion, '1.0.0');
  assert.equal(v2.schemaVersion, '1.1.0');
  assert.equal(v3.schemaVersion, '1.2.0');
  assert.equal('maxArtifactReferenceOccurrences' in v1.limits, false);
  assert.equal('maxArtifactReferenceOccurrences' in v2.limits, false);
  assert.equal(
    v3.limits.maxArtifactReferenceOccurrences,
    MAX_ARTIFACT_REFERENCE_OCCURRENCES,
  );
});

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
      isBrowserCredential: false,
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
        isBrowserCredential: false,
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
  assert.equal(owner.authorizationCapabilities.includes('export.read'), true);
  assert.deepEqual(owner.connectionGrantCeiling.lifecyclePermissions, [
    'board.archive',
    'board.create',
  ]);
  assert.equal(editor.authorizationCapabilities.includes('connection.manage.own'), true);
  assert.equal(editor.authorizationCapabilities.includes('board.admin'), false);
  assert.equal(editor.authorizationCapabilities.includes('export.read'), false);
  assert.deepEqual(editor.connectionGrantCeiling.lifecyclePermissions, []);
  assert.deepEqual(viewer.authorizationCapabilities, ['board.read']);
  assert.deepEqual(viewer.connectionGrantCeiling.scopes, []);
});
