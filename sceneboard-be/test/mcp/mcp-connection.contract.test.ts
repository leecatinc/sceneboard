import assert from 'node:assert/strict';
import test from 'node:test';

import type { PoolConnection } from 'mysql2/promise';

import {
  ACCOUNT_API_KEY_SNAPSHOT,
  type AuthorizedBoardContextV1,
  BoardAccessPolicy,
  ResolvedBoardPrincipalV1,
} from '../../src/grants/board-access.policy.js';
import type {
  AuthorizedBrowserPresencePortV1,
  AuthorizedBrowserPresenceSubjectV1,
} from '../../src/presence/ports/authorized-browser-presence.port.js';
import { McpConnectionService } from '../../src/mcp/mcp-connection.service.js';

const principal = {
  kind: 'mcp',
  actor: {
    principalKind: 'mcp_client',
    principalId: 'client_1',
    grantId: 'grant_1',
    scopes: ['board.read'],
  },
  ownerUserPk: 20n,
  grantPk: 30n,
  credentialPk: 40n,
  grantId: 'grant_1',
  sourceFamilyPublicId: null,
  connectionGrant: {
    grantId: 'grant_1',
    client: {
      clientId: 'client_1',
      clientName: 'SceneBoard Codex',
      installationFingerprint: 'abcdefghijklmnop',
    },
    scopes: ['board.read'],
    lifecyclePermissions: [],
    boardIds: ['board_1'],
    lifetime: 'persistent',
    status: 'active',
    activatedAt: '2026-07-16T16:00:00.000Z',
    expiresAt: '2026-08-16T16:00:00.000Z',
  },
} as unknown as Extract<ResolvedBoardPrincipalV1, { kind: 'mcp' }>;

const accountPrincipal = {
  kind: 'account_api_key',
  actor: {
    principalKind: 'service',
    principalId: 'key_public_1',
    grantId: null,
    scopes: [],
  },
  ownerUserPk: 20n,
  apiKeyPk: 70n,
  scopeMask: 36,
  isBrowserCredential: false,
  [ACCOUNT_API_KEY_SNAPSHOT]: {
    keyPk: '70',
    keyPublicId: 'key_public_1',
    ownerUserPk: '20',
    ownerPublicId: 'user_1',
    scopeMask: 36,
    scopes: ['board:read', 'history:read'],
    expiresAt: Date.parse('2026-08-16T16:00:00.000Z'),
  },
} as unknown as Extract<ResolvedBoardPrincipalV1, { kind: 'account_api_key' }>;

test('null target returns authenticated principal and grant without policy or presence dispatch', async () => {
  let policyCalls = 0;
  let presenceCalls = 0;
  const policy = {
    async withAuthorizedBoardTransaction() {
      policyCalls += 1;
      throw new Error('must not dispatch');
    },
  } as BoardAccessPolicy;
  const presence = {
    captureAuthorizedSubject() {
      presenceCalls += 1;
      return null;
    },
    async getStatus() {
      presenceCalls += 1;
      return 'unknown' as const;
    },
  } as AuthorizedBrowserPresencePortV1;
  const result = await new McpConnectionService(policy, presence).get({
    principal,
    requestId: 'request_1' as never,
    boardId: null,
  });
  assert.equal(result.selectedBoard, null);
  assert.equal(result.principal.principalId, 'client_1');
  assert.equal(result.grant.grantId, 'grant_1');
  assert.equal(policyCalls, 0);
  assert.equal(presenceCalls, 0);
});

test('targeted status composes board summary, capabilities, and post-commit presence in one authorized callback', async () => {
  let callbackActive = false;
  let getStatusAfterCommit = false;
  const connection = {
    async execute() {
      return [
        [
          {
            boardId: 'board_1',
            title: 'SceneBoard',
            createdAt: '2026-07-16 15:00:00.000',
            updatedAt: '2026-07-16 16:00:00.000',
            archivedAt: null,
            revisionId: Buffer.from('00112233445546778899aabbccddeeff', 'hex'),
            revisionNumber: '3',
            revisionCreatedAt: '2026-07-16 16:00:00.000',
          },
        ],
        [],
      ];
    },
  } as unknown as PoolConnection;
  const policy = {
    async withAuthorizedBoardTransaction(
      input: unknown,
      apply: (connection: PoolConnection, context: never) => Promise<unknown>,
    ) {
      assert.deepEqual(input, {
        principal,
        operation: 'board.get',
        boardId: 'board_1',
        isolation: 'REPEATABLE_READ_CUT',
      });
      callbackActive = true;
      const result = await apply(connection, {
        actor: principal.actor,
        ownerUserPk: 20n,
        access: { kind: 'grant', grantPk: 30n, grantId: 'grant_1' },
        createBinding: null,
        artifactCapabilityPolicy: {
          allowedArtifactRequestCapabilities: [],
          policyEpoch: 'abcdefghijklmnopqrstuv',
        },
      } as never);
      callbackActive = false;
      return result;
    },
  } as BoardAccessPolicy;
  const subject = {} as AuthorizedBrowserPresenceSubjectV1;
  const presence = {
    captureAuthorizedSubject() {
      assert.equal(callbackActive, true);
      return subject;
    },
    async getStatus(value: AuthorizedBrowserPresenceSubjectV1) {
      assert.equal(value, subject);
      getStatusAfterCommit = !callbackActive;
      return 'online' as const;
    },
  } as AuthorizedBrowserPresencePortV1;
  const result = await new McpConnectionService(policy, presence).get({
    principal,
    requestId: 'request_1' as never,
    boardId: 'board_1' as never,
  });
  assert.equal(result.selectedBoard?.board.boardId, 'board_1');
  assert.equal(result.selectedBoard?.board.headRevision.revisionNumber, 3);
  assert.equal(result.selectedBoard?.capabilities.grantedCapabilities.includes('board.read'), true);
  assert.equal(result.selectedBoard?.capabilityEpoch, 0);
  assert.equal(result.selectedBoard?.browserPresence, 'online');
  assert.equal(getStatusAfterCommit, true);
});

test('API-key null status returns only safe credential metadata without board or presence dispatch', async () => {
  let policyCalls = 0;
  let presenceCalls = 0;
  const policy = {
    async withAuthorizedBoardTransaction() {
      policyCalls += 1;
      throw new Error('must not dispatch');
    },
  } as BoardAccessPolicy;
  const presence = {
    captureAuthorizedSubject() {
      presenceCalls += 1;
      return null;
    },
    async getStatus() {
      presenceCalls += 1;
      return 'unknown' as const;
    },
  } as AuthorizedBrowserPresencePortV1;
  const result = await new McpConnectionService(policy, presence).get({
    principal: accountPrincipal,
    requestId: 'request_key_1' as never,
    boardId: null,
  });
  assert.deepEqual(result, {
    principal: {
      principalKind: 'service',
      principalId: 'key_public_1',
      grantId: null,
    },
    credential: {
      keyPublicId: 'key_public_1',
      scopes: ['board:read', 'history:read'],
      status: 'active',
      expiresAt: '2026-08-16T16:00:00.000Z',
    },
    selectedBoard: null,
    versions: {
      mcpServer: '0.0.0',
      boardProtocol: '1.0.0',
      api: 'v1',
    },
  });
  assert.equal(policyCalls, 0);
  assert.equal(presenceCalls, 0);
  assert.equal(JSON.stringify(result).includes('ownerUserPk'), false);
  assert.equal(JSON.stringify(result).includes('apiKeyPk'), false);
});

test('API-key targeted status selects a board only through board.get authorization', async () => {
  const connection = {
    async execute() {
      return [
        [
          {
            boardId: 'board_1',
            title: 'SceneBoard',
            createdAt: '2026-07-16 15:00:00.000',
            updatedAt: '2026-07-16 16:00:00.000',
            archivedAt: null,
            revisionId: Buffer.from('00112233445546778899aabbccddeeff', 'hex'),
            revisionNumber: '3',
            revisionCreatedAt: '2026-07-16 16:00:00.000',
          },
        ],
        [],
      ];
    },
  } as unknown as PoolConnection;
  let policyCalls = 0;
  const policy = {
    async withAuthorizedBoardTransaction(
      input: unknown,
      apply: (connection: PoolConnection, context: AuthorizedBoardContextV1) => Promise<unknown>,
    ) {
      policyCalls += 1;
      assert.deepEqual(input, {
        principal: accountPrincipal,
        operation: 'board.get',
        boardId: 'board_1',
        isolation: 'REPEATABLE_READ_CUT',
      });
      return apply(connection, {
        actor: accountPrincipal.actor,
        ownerUserPk: 20n,
        accountUserPk: 20n,
        access: { kind: 'api_key', ownerUserPk: 20n, apiKeyPk: 70n },
        createBinding: null,
        membership: {
          membershipPk: 60n,
          boardPk: 50n,
          accountPk: 20n,
          membershipRole: 'owner',
          membershipVersion: 1,
          capabilityEpoch: 1,
          capabilityEpochEnforced: true,
          operation: 'board.get',
          surface: 'account_api_key',
          write: false,
        },
        artifactCapabilityPolicy: {
          allowedArtifactRequestCapabilities: [],
          policyEpoch: 'abcdefghijklmnopqrstuv',
        },
      });
    },
  } as BoardAccessPolicy;
  const presence = {
    captureAuthorizedSubject() {
      throw new Error('API keys must not touch browser presence');
    },
    async getStatus() {
      throw new Error('API keys must not touch browser presence');
    },
  } as AuthorizedBrowserPresencePortV1;
  const result = await new McpConnectionService(policy, presence).get({
    principal: accountPrincipal,
    requestId: 'request_key_1' as never,
    boardId: 'board_1' as never,
  });
  assert.equal(policyCalls, 1);
  assert.equal(result.selectedBoard?.board.boardId, 'board_1');
  assert.deepEqual(result.selectedBoard?.capabilities.grantedCapabilities, []);
});
