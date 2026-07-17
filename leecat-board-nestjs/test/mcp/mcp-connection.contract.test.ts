import assert from 'node:assert/strict';
import test from 'node:test';

import type { PoolConnection } from 'mysql2/promise';

import type { BoardAccessPolicy, ResolvedBoardPrincipalV1 } from '../../src/grants/board-access.policy.js';
import type { AuthorizedBrowserPresencePortV1, AuthorizedBrowserPresenceSubjectV1 } from '../../src/presence/ports/authorized-browser-presence.port.js';
import { McpConnectionService } from '../../src/mcp/mcp-connection.service.js';

const principal = {
  kind: 'mcp',
  actor: { principalKind: 'mcp_client', principalId: 'client_1', grantId: 'grant_1', scopes: ['board.read'] },
  ownerUserPk: 20n,
  grantPk: 30n,
  credentialPk: 40n,
  grantId: 'grant_1',
  sourceFamilyPublicId: null,
  connectionGrant: {
    grantId: 'grant_1',
    client: { clientId: 'client_1', clientName: 'SceneBoard Codex', installationFingerprint: 'abcdefghijklmnop' },
    scopes: ['board.read'],
    lifecyclePermissions: [],
    boardIds: ['board_1'],
    lifetime: 'persistent',
    status: 'active',
    activatedAt: '2026-07-16T16:00:00.000Z',
    expiresAt: '2026-08-16T16:00:00.000Z',
  },
} as unknown as Extract<ResolvedBoardPrincipalV1, { kind: 'mcp' }>;

test('null target returns authenticated principal and grant without policy or presence dispatch', async () => {
  let policyCalls = 0;
  let presenceCalls = 0;
  const policy = { async withAuthorizedBoardTransaction() { policyCalls += 1; throw new Error('must not dispatch'); } } as BoardAccessPolicy;
  const presence = {
    captureAuthorizedSubject() { presenceCalls += 1; return null; },
    async getStatus() { presenceCalls += 1; return 'unknown' as const; },
  } as AuthorizedBrowserPresencePortV1;
  const result = await new McpConnectionService(policy, presence).get({ principal, requestId: 'request_1' as never, boardId: null });
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
      return [[{
        boardId: 'board_1',
        title: 'SceneBoard',
        createdAt: '2026-07-16 15:00:00.000',
        updatedAt: '2026-07-16 16:00:00.000',
        archivedAt: null,
        revisionId: Buffer.from('00112233445546778899aabbccddeeff', 'hex'),
        revisionNumber: '3',
        revisionCreatedAt: '2026-07-16 16:00:00.000',
      }], []];
    },
  } as unknown as PoolConnection;
  const policy = {
    async withAuthorizedBoardTransaction(input: unknown, apply: (connection: PoolConnection, context: never) => Promise<unknown>) {
      assert.deepEqual(input, { principal, operation: 'board.get', boardId: 'board_1', isolation: 'REPEATABLE_READ_CUT' });
      callbackActive = true;
      const result = await apply(connection, {
        actor: principal.actor,
        ownerUserPk: 20n,
        access: { kind: 'grant', grantPk: 30n, grantId: 'grant_1' },
        createBinding: null,
        artifactCapabilityPolicy: { allowedArtifactRequestCapabilities: [], policyEpoch: 'abcdefghijklmnopqrstuv' },
      } as never);
      callbackActive = false;
      return result;
    },
  } as BoardAccessPolicy;
  const subject = {} as AuthorizedBrowserPresenceSubjectV1;
  const presence = {
    captureAuthorizedSubject() { assert.equal(callbackActive, true); return subject; },
    async getStatus(value: AuthorizedBrowserPresenceSubjectV1) {
      assert.equal(value, subject);
      getStatusAfterCommit = !callbackActive;
      return 'online' as const;
    },
  } as AuthorizedBrowserPresencePortV1;
  const result = await new McpConnectionService(policy, presence).get({ principal, requestId: 'request_1' as never, boardId: 'board_1' as never });
  assert.equal(result.selectedBoard?.board.boardId, 'board_1');
  assert.equal(result.selectedBoard?.board.headRevision.revisionNumber, 3);
  assert.equal(result.selectedBoard?.capabilities.grantedCapabilities.includes('board.read'), true);
  assert.equal(result.selectedBoard?.browserPresence, 'online');
  assert.equal(getStatusAfterCommit, true);
});
