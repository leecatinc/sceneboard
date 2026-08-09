import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  BOARD_AUTHORIZATION_CAPABILITIES_V1,
  BOARD_AUTHORIZATION_OPERATION_TYPES_V1,
  BOARD_AUTHORIZATION_SURFACES_V1,
  BOARD_OPERATION_AUTHORIZATION_MATRIX_V1,
  CLIENT_GRANT_CAPABILITIES_V1,
  CLIENT_GRANT_SCOPE_ORDER_V1,
} from '@sceneboard/board-schema';

import {
  ACCOUNT_API_KEY_BOARD_OPERATIONS_V1,
  ACCOUNT_API_KEY_TOOL_POLICIES_V1,
  accountApiKeyRequiredScopes,
  accountApiKeyToolPolicy,
} from '../../src/api-keys/account-api-key-authorization.policy.js';
import type { AccountApiKeyService } from '../../src/api-keys/account-api-key.service.js';
import { AppError } from '../../src/common/errors/app-error.js';
import { selectBearerCredentialFamilyV1 } from '../../src/common/guards/bearer-credential-family.js';
import { ActorContextService } from '../../src/grants/actor-context.service.js';
import {
  ACCOUNT_API_KEY_SNAPSHOT,
  isBrowserBoardPrincipal,
} from '../../src/grants/board-access.policy.js';
import type { GrantTokenService } from '../../src/grants/grant-token.service.js';
import { membershipPolicyFor } from '../../src/memberships/membership-capability.matrix.js';

const isUnauthenticated = (error: unknown): boolean =>
  error instanceof AppError && error.code === 'UNAUTHENTICATED';

test('selects exactly one canonical bearer family before verification', () => {
  const grant = 'lcbg_v1.AAAAAAAAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  const key = 'sbk_v1.AAAAAAAAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  assert.deepEqual(
    selectBearerCredentialFamilyV1({
      headers: { authorization: `bEaReR ${grant}` },
      rawHeaders: ['Authorization', `bEaReR ${grant}`],
    }),
    { family: 'mcp_grant', token: grant },
  );
  assert.deepEqual(
    selectBearerCredentialFamilyV1({
      headers: { authorization: `Bearer ${key}` },
      rawHeaders: ['authorization', `Bearer ${key}`],
    }),
    { family: 'account_api_key', token: key },
  );

  for (const input of [
    {
      headers: { authorization: `Bearer ${key}, Bearer ${grant}` },
      rawHeaders: ['Authorization', `Bearer ${key}`, 'Authorization', `Bearer ${grant}`],
    },
    {
      headers: { authorization: `Bearer ${key}, Bearer ${grant}` },
      rawHeaders: ['Authorization', `Bearer ${key}, Bearer ${grant}`],
    },
    {
      headers: { authorization: `Bearer  ${key}` },
      rawHeaders: ['Authorization', `Bearer  ${key}`],
    },
    {
      headers: { authorization: `Bearer\t${key}` },
      rawHeaders: ['Authorization', `Bearer\t${key}`],
    },
    {
      headers: { authorization: `Bearer unknown_v1.${key}` },
      rawHeaders: ['Authorization', `Bearer unknown_v1.${key}`],
    },
    {
      headers: { authorization: `Bearer ${key}` },
      rawHeaders: ['Authorization', `Bearer ${grant}`],
    },
  ]) {
    assert.throws(() => selectBearerCredentialFamilyV1(input), isUnauthenticated);
  }
});

test('builds the exact non-browser service principal from an active account key', async () => {
  const snapshot = {
    keyPk: '70',
    keyPublicId: 'key_public_1',
    ownerUserPk: '20',
    ownerPublicId: 'user_1',
    scopeMask: 36,
    scopes: ['board:read', 'history:read'] as const,
    expiresAt: Date.parse('2026-08-01T00:00:00.000Z'),
  };
  const apiKeys = {
    async resolveBearer(token: string, context: unknown, now: number) {
      assert.equal(token.startsWith('sbk_v1.'), true);
      assert.deepEqual(context, {
        correlationId: 'request_key_1',
        clientIp: '192.0.2.10',
      });
      assert.equal(now, 1_800_000_000_000);
      return snapshot;
    },
  } as unknown as AccountApiKeyService;
  const service = new ActorContextService(
    {
      async resolve() {
        return null;
      },
    },
    {} as GrantTokenService,
    apiKeys,
  );
  const principal = await service.resolveAccountApiKey(
    'sbk_v1.AAAAAAAAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    { correlationId: 'request_key_1', clientIp: '192.0.2.10' },
    1_800_000_000_000,
  );
  assert.deepEqual(Object.keys(principal), [
    'kind',
    'actor',
    'ownerUserPk',
    'apiKeyPk',
    'scopeMask',
    'isBrowserCredential',
  ]);
  assert.deepEqual(principal.actor, {
    principalKind: 'service',
    principalId: 'key_public_1',
    grantId: null,
    scopes: [],
  });
  assert.equal(principal.ownerUserPk, 20n);
  assert.equal(principal.apiKeyPk, 70n);
  assert.equal(principal.isBrowserCredential, false);
  assert.equal(principal[ACCOUNT_API_KEY_SNAPSHOT], snapshot);
  assert.equal(isBrowserBoardPrincipal(principal), false);
});

test('owns the closed operation, scope, and literal MCP tool partitions', () => {
  assert.deepEqual(ACCOUNT_API_KEY_BOARD_OPERATIONS_V1, [
    'connection.get',
    'board.list',
    'board.get',
    'board.create',
    'board.rename',
    'board.archive',
    'capabilities.get',
    'scene.replace',
    'scene.clear',
    'scene.restore',
    'document.replace',
    'history.list',
    'history.get',
    'hitl.request',
    'hitl.respond',
    'hitl.read',
    'artifact.get',
    'artifact.publish',
    'artifact.stop',
    'media.upload',
    'export.render',
  ]);
  assert.deepEqual(accountApiKeyRequiredScopes('connection.get'), []);
  assert.deepEqual(accountApiKeyRequiredScopes('scene.restore'), ['board:write', 'history:read']);
  assert.deepEqual(accountApiKeyRequiredScopes('media.upload'), ['board:media:write']);

  assert.deepEqual(Object.keys(ACCOUNT_API_KEY_TOOL_POLICIES_V1), [
    'board_list',
    'board_get',
    'board_scene_get',
    'board_document_get',
    'board_create',
    'board_rename',
    'board_archive',
    'board_capabilities_get',
    'board_scene_replace',
    'board_scene_patch',
    'board_scene_clear',
    'board_document_replace',
    'board_page_add',
    'board_page_remove',
    'board_page_reorder',
    'board_page_update',
    'board_page_default_set',
    'board_history_list',
    'board_history_get',
    'board_history_restore',
    'board_artifact_get',
    'board_artifact_put',
    'board_artifact_stop',
    'board_interaction_request',
    'board_interaction_status',
    'board_interaction_respond',
    'sceneboard_media_upload',
    'sceneboard_media_place',
    'board_export',
  ]);
  assert.deepEqual(accountApiKeyToolPolicy('board_history_restore'), {
    operationPlans: [{ operations: ['scene.restore'], scopes: ['board:write', 'history:read'] }],
  });
  assert.deepEqual(accountApiKeyToolPolicy('board_export'), {
    operationPlans: [{ operations: ['export.render'], scopes: ['export:read'] }],
  });
  assert.deepEqual(accountApiKeyToolPolicy('board_scene_get'), {
    operationPlans: [
      { operations: ['board.get'], scopes: ['board:read'] },
      { operations: ['history.get'], scopes: ['history:read'] },
    ],
  });
  assert.deepEqual(accountApiKeyToolPolicy('board_scene_patch'), {
    operationPlans: [
      { operations: ['board.get', 'scene.replace'], scopes: ['board:read', 'board:write'] },
    ],
  });
  assert.deepEqual(accountApiKeyToolPolicy('sceneboard_media_place'), {
    operationPlans: [
      {
        operations: ['history.get', 'document.replace'],
        scopes: ['history:read', 'board:write'],
      },
    ],
  });
  assert.equal(accountApiKeyToolPolicy('future_document_replace_alias'), null);
});

test('appends only the approved API-key authorization surfaces and preserves grant catalogs', () => {
  assert.deepEqual(BOARD_AUTHORIZATION_SURFACES_V1, ['browser', 'mcp', 'account_api_key']);
  assert.deepEqual(CLIENT_GRANT_CAPABILITIES_V1, [
    'artifact.control',
    'artifact.publish',
    'board.history.read',
    'board.hitl.request',
    'board.hitl.respond',
    'board.media.write',
    'board.read',
    'board.write',
  ]);
  assert.deepEqual(CLIENT_GRANT_SCOPE_ORDER_V1, [
    'board.read',
    'board.write',
    'board.history.read',
    'board.hitl.request',
    'board.hitl.respond',
    'board.media.write',
    'artifact.publish',
    'artifact.control',
  ]);
  assert.equal(BOARD_AUTHORIZATION_CAPABILITIES_V1.at(-1), 'export.read');
  assert.equal(BOARD_AUTHORIZATION_OPERATION_TYPES_V1.at(-1), 'export.render');

  const apiKeyRows = BOARD_OPERATION_AUTHORIZATION_MATRIX_V1.filter((row) =>
    row.surfaces.includes('account_api_key'),
  );
  assert.deepEqual(
    apiKeyRows.map((row) => row.operation),
    [
      'board.list',
      'board.get',
      'capabilities.get',
      'artifact.get',
      'hitl.read',
      'history.list',
      'history.get',
      'board.create',
      'board.rename',
      'document.replace',
      'scene.replace',
      'scene.clear',
      'scene.restore',
      'hitl.request',
      'hitl.respond',
      'artifact.publish',
      'artifact.stop',
      'board.archive',
      'media.upload',
      'export.render',
    ],
  );
  assert.deepEqual(membershipPolicyFor('export.render', 'account_api_key'), {
    operation: 'export.render',
    surfaces: ['browser', 'account_api_key'],
    requiredCapabilities: ['export.read'],
    roles: { owner: true, editor: false, viewer: false },
    viewerResourceScope: 'all',
    runtimeOwner: 'I-50',
  });
  for (const operation of [
    'page.add',
    'page.update',
    'page.remove',
    'page.reorder',
    'page.default.set',
    'connection.create',
    'connection.update',
    'connection.revoke',
    'board.delete',
    'membership.list',
    'membership.invite',
    'membership.role.update',
    'membership.remove',
    'ownership.transfer',
    'share.list',
    'share.publish',
    'share.update',
    'share.rotate',
    'share.revoke',
    'share.password.enable',
    'share.password.regenerate',
    'share.password.disable',
    'analytics.report.get',
  ]) {
    assert.equal(membershipPolicyFor(operation, 'account_api_key'), null);
  }
});
