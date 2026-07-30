import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  BoardIdParserV1,
  GrantIdParserV1,
  normalizeActorContextV1,
  type ActorContextV1,
  type BoardId,
  type GrantId,
} from '@sceneboard/board-schema';
import type { PoolConnection } from 'mysql2/promise';

import type { AccountApiKeyService } from '../../src/api-keys/account-api-key.service.js';
import type { ActiveAccountApiKeySnapshot } from '../../src/api-keys/account-api-key.repository.js';
import { AppError } from '../../src/common/errors/app-error.js';
import { BoardContractError } from '../../src/common/errors/app-error.js';
import type { CryptoService } from '../../src/common/security/crypto.service.js';
import type { MysqlService } from '../../src/database/mysql.service.js';
import {
  ACCOUNT_API_KEY_SNAPSHOT,
  type ResolvedBoardPrincipalV1,
} from '../../src/grants/board-access.policy.js';
import { MysqlBoardAccessPolicy } from '../../src/grants/board-access-policy.service.js';
import { MembershipRepository } from '../../src/memberships/membership.repository.js';
import { BoardMembershipAuthorizationService } from '../../src/memberships/membership.service.js';

type QueryResult = readonly [unknown, unknown];

const actor = (input: unknown): ActorContextV1 => {
  const result = normalizeActorContextV1(input);
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error('invalid actor fixture');
  return result.data.value;
};

const boardId = (value: string): BoardId => {
  const result = BoardIdParserV1.parse(value);
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error('invalid board fixture');
  return result.data.value;
};

const grantId = (value: string): GrantId => {
  const result = GrantIdParserV1.parse(value);
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error('invalid grant fixture');
  return result.data.value;
};

const userPrincipal = (): Extract<ResolvedBoardPrincipalV1, { kind: 'user' }> => ({
  kind: 'user',
  actor: actor({
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
  }),
  userPk: 20n,
  sessionPk: 21n,
  familyPublicId: 'family_1',
  isBrowserCredential: true,
});

const mcpPrincipal = (
  scopes: readonly ('board.read' | 'board.write')[] = ['board.read', 'board.write'],
): Extract<ResolvedBoardPrincipalV1, { kind: 'mcp' }> => ({
  kind: 'mcp',
  actor: actor({
    principalKind: 'mcp_client',
    principalId: 'client_1',
    grantId: 'grant_1',
    scopes,
  }),
  ownerUserPk: 20n,
  grantPk: 30n,
  credentialPk: 40n,
  grantId: grantId('grant_1'),
  sourceFamilyPublicId: null,
  isBrowserCredential: false,
});

const accountApiKeySnapshot = (
  scopes: ActiveAccountApiKeySnapshot['scopes'] = [
    'board:archive',
    'board:create',
    'board:read',
    'board:write',
    'export:read',
    'history:read',
  ],
): ActiveAccountApiKeySnapshot => ({
  keyPk: '70',
  keyPublicId: 'key_public_1',
  ownerUserPk: '20',
  ownerPublicId: 'user_1',
  scopeMask: 63,
  scopes,
  expiresAt: Date.parse('2026-07-17T00:00:00.000Z'),
});

const accountApiKeyPrincipal = (
  snapshot = accountApiKeySnapshot(),
): Extract<ResolvedBoardPrincipalV1, { kind: 'account_api_key' }> => ({
  kind: 'account_api_key',
  actor: actor({
    principalKind: 'service',
    principalId: snapshot.keyPublicId,
    grantId: null,
    scopes: [],
  }),
  ownerUserPk: BigInt(snapshot.ownerUserPk),
  apiKeyPk: BigInt(snapshot.keyPk),
  scopeMask: snapshot.scopeMask,
  isBrowserCredential: false,
  [ACCOUNT_API_KEY_SNAPSHOT]: snapshot,
});

interface SetupOptions {
  grantScopeMask?: number;
  grantLifecycleMask?: number;
  archivedAt?: string | null;
  boardOwnerPk?: bigint;
  membershipRoles?: Array<'owner' | 'editor' | 'viewer' | null>;
  apiKeyRecheckFailureAt?: number;
}

const setup = (options: SetupOptions = {}) => {
  const calls: string[] = [];
  const epoch = Buffer.alloc(16, 7);
  const connection = {
    async query(sql: string) {
      const normalized = sql.replace(/\s+/g, ' ').trim();
      calls.push(normalized);
      return [[], []] as QueryResult;
    },
    async beginTransaction() {
      calls.push('BEGIN');
    },
    async commit() {
      calls.push('COMMIT');
    },
    async rollback() {
      calls.push('ROLLBACK');
    },
    async execute(sql: string) {
      const normalized = sql.replace(/\s+/g, ' ').trim();
      calls.push(normalized);
      if (normalized.includes('UTC_TIMESTAMP(3) AS transactionNow')) {
        return [[{ transactionNow: '2026-07-16 12:00:00.000' }], []] as QueryResult;
      }
      if (normalized.includes('FROM users') && normalized.includes('FOR UPDATE')) {
        return [[{ userPk: '20', publicId: 'user_1', status: 1 }], []] as QueryResult;
      }
      if (normalized.includes('FROM auth_sessions') && normalized.includes('FOR UPDATE')) {
        return [
          [
            {
              sessionPk: '21',
              userPk: '20',
              familyPublicId: 'family_1',
              status: 1,
              idleExpiresAt: '2026-07-17 00:00:00.000',
              absoluteExpiresAt: '2026-07-18 00:00:00.000',
            },
          ],
          [],
        ] as QueryResult;
      }
      if (normalized.includes('FROM mcp_grants') && normalized.includes('FOR UPDATE')) {
        return [
          [
            {
              grantPk: '30',
              publicId: 'grant_1',
              ownerUserPk: '20',
              sourceSessionPk: null,
              scopeMask: options.grantScopeMask ?? 3,
              lifecycleMask: options.grantLifecycleMask ?? 1,
              lifetime: 2,
              status: 2,
              expiresAt: '2026-07-17 00:00:00.000',
            },
          ],
          [],
        ] as QueryResult;
      }
      if (normalized.includes('FROM mcp_grant_credentials') && normalized.includes('FOR UPDATE')) {
        return [[{ credentialPk: '40', grantPk: '30', status: 1 }], []] as QueryResult;
      }
      if (normalized.includes('FROM boards b')) {
        return [
          [
            {
              boardPk: '50',
              ownerUserPk: (options.boardOwnerPk ?? 20n).toString(),
              archivedAt: options.archivedAt ?? null,
            },
          ],
          [],
        ] as QueryResult;
      }
      if (normalized.includes('FROM board_artifact_capability_policy_epochs')) {
        return [
          [{ ownerUserPk: (options.boardOwnerPk ?? 20n).toString(), policyEpoch: epoch }],
          [],
        ] as QueryResult;
      }
      if (normalized.includes('FROM board_artifact_capability_policies')) {
        return [[{ capability: 'download' }, { capability: 'network.fetch' }], []] as QueryResult;
      }
      if (normalized.startsWith('INSERT INTO mcp_grant_boards')) {
        return [{ affectedRows: 1 }, []] as QueryResult;
      }
      if (normalized.includes('FROM mcp_grant_boards')) {
        return [[{ grantPk: '30' }], []] as QueryResult;
      }
      throw new Error(`unexpected SQL: ${normalized}`);
    },
  };
  let connectionCount = 0;
  const mysql = {
    async withConnection<T>(work: (value: PoolConnection) => Promise<T>) {
      connectionCount += 1;
      return work(connection as unknown as PoolConnection);
    },
  } as MysqlService;
  const crypto = { random: (length: number) => Buffer.alloc(length, 9) } as CryptoService;
  const membershipRoles = [...(options.membershipRoles ?? [])];
  let ownerMembershipCreations = 0;
  const memberships =
    options.membershipRoles === undefined
      ? null
      : new BoardMembershipAuthorizationService({
          findActive: async () => {
            const role = membershipRoles.shift() ?? null;
            return role === null
              ? null
              : {
                  membershipPk: 60n,
                  boardPk: 50n,
                  accountPk: 20n,
                  role,
                  version: role === 'viewer' ? 2 : 1,
                };
          },
          adoptCanonicalOwner: async () => undefined,
          createOwner: async () => {
            ownerMembershipCreations += 1;
          },
        } as unknown as MembershipRepository);
  let apiKeyRechecks = 0;
  const accountApiKeys = {
    async recheckActive() {
      apiKeyRechecks += 1;
      if (apiKeyRechecks === options.apiKeyRecheckFailureAt) {
        throw new AppError('UNAUTHENTICATED');
      }
    },
  } as unknown as AccountApiKeyService;
  return {
    policy: new MysqlBoardAccessPolicy(
      mysql,
      crypto,
      {
        retryJitter: () => 0,
        sleep: async () => undefined,
      },
      memberships,
      accountApiKeys,
    ),
    calls,
    connectionCount: () => connectionCount,
    apiKeyRechecks: () => apiKeyRechecks,
    ownerMembershipCreations: () => ownerMembershipCreations,
  };
};

const isBoardError =
  (code: string) =>
  (error: unknown): boolean =>
    error instanceof BoardContractError && error.boardError.code === code;

test('rejects operation target and isolation drift before acquiring a connection', async () => {
  const value = setup();
  await assert.rejects(
    value.policy.withAuthorizedBoardTransaction(
      {
        principal: userPrincipal(),
        operation: 'board.list',
        boardId: null,
        isolation: 'READ_COMMITTED_WRITE',
      },
      async () => 'unreachable',
    ),
    isBoardError('FORBIDDEN'),
  );
  assert.equal(value.connectionCount(), 0);
});

test('revalidates the current user family and commits before exposing board work', async () => {
  const value = setup();
  const order: string[] = [];
  const result = await value.policy.withAuthorizedBoardTransaction(
    {
      principal: userPrincipal(),
      operation: 'board.get',
      boardId: boardId('board_1'),
      isolation: 'REPEATABLE_READ_CUT',
    },
    async (_connection, context) => {
      order.push('apply');
      assert.deepEqual(context.access, { kind: 'owner', ownerUserPk: 20n });
      assert.deepEqual(context.artifactCapabilityPolicy, {
        allowedArtifactRequestCapabilities: ['download', 'network.fetch'],
        policyEpoch: epochBase64Url(7),
      });
      return 'authorized';
    },
  );
  order.push('returned');
  assert.equal(result, 'authorized');
  assert.ok(
    value.calls.indexOf('COMMIT') > value.calls.findIndex((call) => call.includes('FROM boards b')),
  );
  assert.deepEqual(order, ['apply', 'returned']);
});

test('gives MCP board.create one same-connection binding call and closes it after apply', async () => {
  const value = setup();
  let captured: ((createdBoardId: BoardId) => Promise<void>) | undefined;
  await value.policy.withAuthorizedBoardTransaction(
    {
      principal: mcpPrincipal(),
      operation: 'board.create',
      boardId: null,
      isolation: 'READ_COMMITTED_WRITE',
    },
    async (_connection, context) => {
      assert.equal(context.createBinding?.grantPk, 30n);
      captured = context.createBinding?.bindCreatedBoard;
      await captured?.(boardId('board_new'));
      await assert.rejects(captured?.(boardId('board_other')), isBoardError('INTERNAL_ERROR'));
      return undefined;
    },
  );
  assert.equal(
    value.calls.filter((call) => call.startsWith('INSERT INTO mcp_grant_boards')).length,
    1,
  );
  assert.ok(captured);
  await assert.rejects(captured?.(boardId('board_new')), isBoardError('INTERNAL_ERROR'));
});

test('denies stale MCP scope before board binding or protected apply work', async () => {
  const value = setup({ grantScopeMask: 1 });
  let applied = false;
  await assert.rejects(
    value.policy.withAuthorizedBoardTransaction(
      {
        principal: mcpPrincipal(['board.read']),
        operation: 'board.create',
        boardId: null,
        isolation: 'READ_COMMITTED_WRITE',
      },
      async () => {
        applied = true;
      },
    ),
    isBoardError('FORBIDDEN'),
  );
  assert.equal(applied, false);
  assert.equal(
    value.calls.some((call) => call.includes('FROM mcp_grant_boards')),
    false,
  );
});

test('keeps rename and export unreachable to pairing grants even with owner membership', async () => {
  for (const operation of ['board.rename', 'export.render'] as const) {
    const value = setup({ membershipRoles: ['owner'] });
    await assert.rejects(
      value.policy.withAuthorizedBoardTransaction(
        {
          principal: mcpPrincipal(),
          operation,
          boardId: boardId('board_1'),
          isolation: operation === 'export.render' ? 'REPEATABLE_READ_CUT' : 'READ_COMMITTED_WRITE',
        },
        async () => 'unreachable',
      ),
      isBoardError('BOARD_NOT_FOUND'),
    );
  }
});

test('returns the archived conflict only after current owner authorization', async () => {
  const value = setup({ archivedAt: '2026-07-16 12:00:00.000' });
  let applied = false;
  await assert.rejects(
    value.policy.withAuthorizedBoardTransaction(
      {
        principal: userPrincipal(),
        operation: 'scene.clear',
        boardId: boardId('board_1'),
        isolation: 'READ_COMMITTED_WRITE',
      },
      async () => {
        applied = true;
      },
    ),
    (error: unknown) =>
      error instanceof BoardContractError &&
      error.boardError.code === 'BOARD_ALREADY_ARCHIVED' &&
      error.boardError.details.boardId === 'board_1' &&
      error.boardError.details.archivedAt === '2026-07-16T12:00:00.000Z',
  );
  assert.equal(applied, false);
  assert.equal(
    value.calls.some((call) => call.includes('FROM boards b')),
    true,
  );
});

test('normalizes unrelated and role-forbidden authenticated board access to one 404 body', async () => {
  const attempts = [
    setup({ boardOwnerPk: 99n, membershipRoles: [null] }),
    setup({ boardOwnerPk: 99n, membershipRoles: ['viewer'] }),
  ];
  const errors: unknown[] = [];
  for (const value of attempts) {
    try {
      await value.policy.withAuthorizedBoardTransaction(
        {
          principal: userPrincipal(),
          operation: 'history.get',
          boardId: boardId('board_1'),
          isolation: 'REPEATABLE_READ_CUT',
        },
        async () => 'unreachable',
      );
    } catch (error) {
      errors.push(error);
    }
  }
  assert.equal(errors.length, 2);
  assert.ok(errors.every(isBoardError('BOARD_NOT_FOUND')));
  assert.deepEqual(
    errors.map((error) => (error as BoardContractError).boardError),
    [errors[0], errors[0]].map((error) => (error as BoardContractError).boardError),
  );
});

test('rolls back a write when the locked membership version or role changes before commit', async () => {
  const value = setup({
    boardOwnerPk: 99n,
    membershipRoles: ['editor', 'viewer'],
  });
  let applied = false;
  await assert.rejects(
    value.policy.withAuthorizedBoardTransaction(
      {
        principal: userPrincipal(),
        operation: 'scene.clear',
        boardId: boardId('board_1'),
        isolation: 'READ_COMMITTED_WRITE',
      },
      async () => {
        applied = true;
        return 'rolled-back';
      },
    ),
    isBoardError('BOARD_NOT_FOUND'),
  );
  assert.equal(applied, true);
  assert.equal(value.calls.includes('ROLLBACK'), true);
  assert.equal(value.calls.includes('COMMIT'), false);
});

test('authorizes an owner API key with the literal scope and rechecks it before and after work', async () => {
  const value = setup({ membershipRoles: ['owner', 'owner'] });
  const principal = accountApiKeyPrincipal();
  const result = await value.policy.withAuthorizedBoardTransaction(
    {
      principal,
      operation: 'scene.clear',
      boardId: boardId('board_1'),
      isolation: 'READ_COMMITTED_WRITE',
    },
    async (_connection, context) => {
      assert.deepEqual(context.access, {
        kind: 'api_key',
        ownerUserPk: 20n,
        apiKeyPk: 70n,
      });
      assert.equal(context.accountUserPk, 20n);
      return 'authorized';
    },
  );
  assert.equal(result, 'authorized');
  assert.equal(value.apiKeyRechecks(), 2);
  assert.equal(value.calls.includes('COMMIT'), true);
});

test('creates API-key owner membership through the same authorized transaction capability', async () => {
  const value = setup({ membershipRoles: [] });
  await value.policy.withAuthorizedBoardTransaction(
    {
      principal: accountApiKeyPrincipal(),
      operation: 'board.create',
      boardId: null,
      isolation: 'READ_COMMITTED_WRITE',
    },
    async (_connection, context) => {
      assert.ok(context.createOwnerMembership);
      await context.createOwnerMembership.create(50n, '2026-07-16 12:00:00.000');
    },
  );
  assert.equal(value.ownerMembershipCreations(), 1);
  assert.equal(value.apiKeyRechecks(), 2);
  assert.equal(value.calls.includes('COMMIT'), true);
});

test('denies a key missing one composite restore scope before board work', async () => {
  const snapshot = accountApiKeySnapshot(['history:read']);
  const value = setup({ membershipRoles: ['owner'] });
  let applied = false;
  await assert.rejects(
    value.policy.withAuthorizedBoardTransaction(
      {
        principal: accountApiKeyPrincipal(snapshot),
        operation: 'scene.restore',
        boardId: boardId('board_1'),
        isolation: 'READ_COMMITTED_WRITE',
      },
      async () => {
        applied = true;
      },
    ),
    isBoardError('BOARD_NOT_FOUND'),
  );
  assert.equal(applied, false);
  assert.equal(value.apiKeyRechecks(), 0);
  assert.equal(
    value.calls.some((call) => call.includes('FROM boards b')),
    false,
  );
});

test('keeps membership and share administration outside the API-key partition', async () => {
  for (const operation of ['membership.list', 'share.list'] as const) {
    const value = setup({ membershipRoles: ['owner'] });
    await assert.rejects(
      value.policy.withAuthorizedBoardTransaction(
        {
          principal: accountApiKeyPrincipal(),
          operation,
          boardId: boardId('board_1'),
          isolation: 'REPEATABLE_READ_CUT',
        },
        async () => 'unreachable',
      ),
      isBoardError('BOARD_NOT_FOUND'),
    );
    assert.equal(value.apiKeyRechecks(), 0);
  }
});

test('normalizes non-owner API-key membership to board-not-found', async () => {
  const value = setup({ boardOwnerPk: 99n, membershipRoles: ['editor'] });
  await assert.rejects(
    value.policy.withAuthorizedBoardTransaction(
      {
        principal: accountApiKeyPrincipal(),
        operation: 'board.get',
        boardId: boardId('board_1'),
        isolation: 'REPEATABLE_READ_CUT',
      },
      async () => 'unreachable',
    ),
    isBoardError('BOARD_NOT_FOUND'),
  );
});

test('rolls back API-key mutation when the locked credential changes before commit', async () => {
  const value = setup({
    membershipRoles: ['owner'],
    apiKeyRecheckFailureAt: 2,
  });
  let applied = false;
  await assert.rejects(
    value.policy.withAuthorizedBoardTransaction(
      {
        principal: accountApiKeyPrincipal(),
        operation: 'scene.clear',
        boardId: boardId('board_1'),
        isolation: 'READ_COMMITTED_WRITE',
      },
      async () => {
        applied = true;
      },
    ),
    isBoardError('UNAUTHENTICATED'),
  );
  assert.equal(applied, true);
  assert.equal(value.apiKeyRechecks(), 2);
  assert.equal(value.calls.includes('ROLLBACK'), true);
  assert.equal(value.calls.includes('COMMIT'), false);
});

const epochBase64Url = (byte: number): string => Buffer.alloc(16, byte).toString('base64url');
