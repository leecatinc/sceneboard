import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import type { SessionRecord } from '../../src/auth/session.service.js';
import {
  AUTHORIZED_BOARD_OPERATIONS_V1,
  authorizationRuleFor,
  type AuthorizedBoardOperationV1,
} from '../../src/grants/board-access.policy.js';
import {
  ActorContextService,
  type GrantPrincipalPersistence,
} from '../../src/grants/actor-context.service.js';
import type { GrantTokenService } from '../../src/grants/grant-token.service.js';

const session: SessionRecord = {
  databaseId: '10',
  publicId: 'session_1',
  familyPublicId: 'family_1',
  tokenHash: Buffer.alloc(32),
  status: 'active',
  user: {
    databaseId: '20',
    publicId: 'user_1',
    email: 'user@example.dev',
    status: 'active',
    createdAt: '2026-07-16T00:00:00.000Z',
  },
  idleExpiresAt: Date.parse('2026-07-17T00:00:00.000Z'),
  absoluteExpiresAt: Date.parse('2026-08-16T00:00:00.000Z'),
};

test('constructs user and MCP actors only from resolved principals with D1 scope order', async () => {
  const persistence: GrantPrincipalPersistence = {
    async resolve() {
      return {
        ownerUserDatabaseId: '20',
        grantDatabaseId: '30',
        credentialDatabaseId: '40',
        clientPublicId: 'client_1',
        grantPublicId: 'grant_1',
        sourceFamilyPublicId: null,
        scopeMask: 67,
        connectionGrant: {
          grantId: 'grant_1' as never,
          client: {
            clientId: 'client_1',
            clientName: 'SceneBoard Codex',
            installationFingerprint: 'abcdefghijklmnop',
          },
          scopes: ['board.read', 'board.write', 'artifact.control'],
          lifecyclePermissions: [],
          boardIds: ['board_1' as never],
          lifetime: 'persistent',
          status: 'active',
          activatedAt: '2026-07-16T11:00:00.000Z',
          expiresAt: '2026-08-16T11:00:00.000Z',
        },
      };
    },
  };
  const tokens = {
    parseAndHash(token: string) {
      assert.equal(token, 'lcbg_v1.locator.secret');
      return { locator: Buffer.alloc(16, 1), tokenHash: Buffer.alloc(32, 2) };
    },
  } as GrantTokenService;
  const service = new ActorContextService(persistence, tokens);

  const user = service.resolveUser(session);
  assert.deepEqual(user.actor, {
    principalKind: 'user',
    principalId: 'user_1',
    grantId: null,
    scopes: [
      'artifact.control',
      'artifact.publish',
      'board.history.read',
      'board.hitl.request',
      'board.hitl.respond',
      'board.read',
      'board.write',
    ],
  });
  assert.equal(user.userPk, 20n);
  assert.equal(user.sessionPk, 10n);

  const mcp = await service.resolveMcp(
    'Bearer lcbg_v1.locator.secret',
    Date.parse('2026-07-16T12:00:00.000Z'),
  );
  assert.deepEqual(mcp.actor, {
    principalKind: 'mcp_client',
    principalId: 'client_1',
    grantId: 'grant_1',
    scopes: ['artifact.control', 'board.read', 'board.write'],
  });
  assert.equal(mcp.ownerUserPk, 20n);
  assert.equal(mcp.grantPk, 30n);
  assert.equal(mcp.credentialPk, 40n);
  assert.deepEqual(mcp.connectionGrant?.scopes, ['board.read', 'board.write', 'artifact.control']);
});

test('rejects non-exact bearer transport before persistence and has one normalizer call site', async () => {
  let persistenceCalls = 0;
  const persistence: GrantPrincipalPersistence = {
    async resolve() {
      persistenceCalls += 1;
      return null;
    },
  };
  const tokens = {
    parseAndHash() {
      throw new Error('must not parse malformed transport');
    },
  } as unknown as GrantTokenService;
  const service = new ActorContextService(persistence, tokens);
  for (const value of [
    '',
    'bearer token',
    'Bearer  token',
    'Bearer token ',
    'PairingProof token',
  ]) {
    await assert.rejects(() => service.resolveMcp(value, Date.now()));
  }
  assert.equal(persistenceCalls, 0);

  const source = await readFile(
    new URL('../../src/grants/actor-context.service.ts', import.meta.url),
    'utf8',
  );
  assert.equal(source.match(/normalizeActorContextV1\s*\(/g)?.length, 1);
});

test('owns the exact sixteen-operation authorization matrix', () => {
  const expected: readonly AuthorizedBoardOperationV1[] = [
    'board.list',
    'board.get',
    'capabilities.get',
    'board.create',
    'board.archive',
    'scene.replace',
    'scene.clear',
    'scene.restore',
    'history.list',
    'history.get',
    'hitl.request',
    'hitl.respond',
    'hitl.read',
    'artifact.get',
    'artifact.publish',
    'artifact.stop',
  ];
  assert.deepEqual(AUTHORIZED_BOARD_OPERATIONS_V1, expected);
  assert.equal(new Set(AUTHORIZED_BOARD_OPERATIONS_V1).size, 16);
  assert.deepEqual(authorizationRuleFor('scene.restore').requiredCapabilities, [
    'board.write',
    'board.history.read',
  ]);
  assert.equal(authorizationRuleFor('board.create').requiredLifecyclePermission, 'board.create');
  assert.equal(authorizationRuleFor('board.archive').requiredLifecyclePermission, 'board.archive');
  assert.equal(authorizationRuleFor('board.list').target, 'null');
  assert.equal(authorizationRuleFor('board.create').target, 'null');
  for (const operation of AUTHORIZED_BOARD_OPERATIONS_V1) {
    const rule = authorizationRuleFor(operation);
    assert.equal(
      rule.isolation,
      [
        'board.list',
        'board.get',
        'capabilities.get',
        'history.list',
        'history.get',
        'hitl.read',
        'artifact.get',
      ].includes(operation)
        ? 'REPEATABLE_READ_CUT'
        : 'READ_COMMITTED_WRITE',
    );
    if (operation !== 'board.list' && operation !== 'board.create')
      assert.equal(rule.target, 'board');
  }
});
