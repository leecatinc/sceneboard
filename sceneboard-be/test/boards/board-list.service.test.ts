import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  BoardOperationRequestParserV1,
  BoardOperationResultParserV1,
  normalizeActorContextV1,
  type ActorContextV1,
  type GrantId,
} from '@sceneboard/board-schema';
import type { PoolConnection } from 'mysql2/promise';

import { BoardListCursorCodec } from '../../src/boards/board-list-cursor.codec.js';
import { BoardListService, type BoardListRequestV1 } from '../../src/boards/board-list.service.js';
import { createCursorMacKeyV1 } from '../../src/common/security/cursor-mac-key.js';
import {
  ACCOUNT_API_KEY_SNAPSHOT,
  type AuthorizedBoardContextV1,
  type AuthorizedBoardTransactionInputV1,
  type BoardAccessPolicy,
  type ResolvedBoardPrincipalV1,
} from '../../src/grants/board-access.policy.js';

const actor = (kind: 'user' | 'mcp_client' | 'service'): ActorContextV1 => {
  const parsed = normalizeActorContextV1({
    principalKind: kind,
    principalId: kind === 'user' ? 'user_1' : kind === 'mcp_client' ? 'client_1' : 'key_public_1',
    grantId: kind === 'mcp_client' ? 'grant_1' : null,
    scopes: kind === 'service' ? [] : ['board.read'],
  });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) throw new Error('invalid actor fixture');
  return parsed.data.value;
};

const request = (cursor: string | null = null): BoardListRequestV1 => {
  const parsed = BoardOperationRequestParserV1.parse({
    protocolVersion: 1,
    requestId: 'request_list_1',
    type: 'board.list',
    cursor,
    limit: 2,
    includeArchived: false,
  });
  assert.equal(parsed.ok, true);
  if (!parsed.ok || parsed.data.value.type !== 'board.list')
    throw new Error('invalid request fixture');
  return parsed.data.value as BoardListRequestV1;
};

const row = (boardPk: string, createdSecond: number, uuidByte: string) => ({
  boardId: `board_${boardPk}`,
  title: `Board ${boardPk}`,
  boardCreatedAt: `2026-07-16 12:00:${String(createdSecond).padStart(2, '0')}.000`,
  boardUpdatedAt: `2026-07-16 12:01:${String(createdSecond).padStart(2, '0')}.000`,
  archivedAt: null,
  headRevisionId: Buffer.from(
    `${uuidByte.repeat(12)}4${uuidByte.repeat(3)}8${uuidByte.repeat(15)}`,
    'hex',
  ),
  headRevisionNumber: boardPk,
  headRevisionCreatedAt: `2026-07-16 12:01:${String(createdSecond).padStart(2, '0')}.000`,
});

type BoardListFixtureRow = ReturnType<typeof row>;

const setup = (kind: 'owner' | 'grant' | 'account_api_key', pages?: BoardListFixtureRow[][]) => {
  const calls: Array<{ sql: string; binds: unknown[] }> = [];
  const rows = [row('3', 3, 'a'), row('2', 2, 'b'), row('1', 1, 'c')];
  const connection = {
    async execute(sql: string, binds: unknown[]): Promise<[unknown, unknown]> {
      const normalized = sql.replace(/\s+/g, ' ').trim();
      calls.push({ sql: normalized, binds });
      return [pages?.[calls.length - 1] ?? rows, []];
    },
  } as unknown as PoolConnection;
  const principal: ResolvedBoardPrincipalV1 =
    kind === 'owner'
      ? {
          kind: 'user',
          actor: actor('user'),
          userPk: 20n,
          sessionPk: 21n,
          familyPublicId: 'family_1',
          isBrowserCredential: true,
        }
      : kind === 'grant'
        ? {
            kind: 'mcp',
            actor: actor('mcp_client'),
            ownerUserPk: 20n,
            grantPk: 30n,
            credentialPk: 40n,
            grantId: 'grant_1' as GrantId,
            sourceFamilyPublicId: null,
            isBrowserCredential: false,
          }
        : {
            kind: 'account_api_key',
            actor: actor('service'),
            ownerUserPk: 20n,
            apiKeyPk: 70n,
            scopeMask: 4,
            isBrowserCredential: false,
            [ACCOUNT_API_KEY_SNAPSHOT]: {
              keyPk: '70',
              keyPublicId: 'key_public_1',
              ownerUserPk: '20',
              ownerPublicId: 'user_1',
              scopeMask: 4,
              scopes: ['board:read'],
              expiresAt: Date.parse('2026-07-17T00:00:00.000Z'),
            },
          };
  const context: AuthorizedBoardContextV1 = {
    actor: principal.actor,
    ownerUserPk: 20n,
    access:
      kind === 'owner'
        ? { kind: 'owner', ownerUserPk: 20n }
        : kind === 'grant'
          ? { kind: 'grant', grantPk: 30n, grantId: 'grant_1' as GrantId }
          : { kind: 'api_key', ownerUserPk: 20n, apiKeyPk: 70n },
    createBinding: null,
    ...(kind === 'account_api_key' ? { accountUserPk: 20n, membership: null } : {}),
    artifactCapabilityPolicy: {
      allowedArtifactRequestCapabilities: [],
      policyEpoch: 'AAAAAAAAAAAAAAAAAAAAAA',
    },
  };
  const policy: BoardAccessPolicy = {
    async withAuthorizedBoardTransaction<T>(
      input: AuthorizedBoardTransactionInputV1,
      apply: (value: PoolConnection, authorized: AuthorizedBoardContextV1) => Promise<T>,
    ) {
      assert.equal(input.operation, 'board.list');
      assert.equal(input.boardId, null);
      assert.equal(input.isolation, 'REPEATABLE_READ_CUT');
      return apply(connection, context);
    },
  };
  const cursors = new BoardListCursorCodec(createCursorMacKeyV1(Buffer.alloc(32, 4)));
  return { calls, cursors, principal, service: new BoardListService(policy, cursors) };
};

test('owner board page uses one narrow limit+1 projection and cursors from the last returned row', async () => {
  const value = setup('owner');
  const result = await value.service.list({ principal: value.principal, request: request() });
  assert.equal(BoardOperationResultParserV1.parse(result).ok, true);
  assert.equal(result.result.type, 'board.list');
  if (result.result.type !== 'board.list' || result.result.nextCursor === null) return;
  assert.deepEqual(
    result.result.boards.map((board: { boardId: string }) => board.boardId),
    ['board_3', 'board_2'],
  );
  assert.deepEqual(
    value.cursors.parse({
      cursor: result.result.nextCursor,
      limit: 2,
      includeArchived: false,
      access: { accessKind: 'owner', ownerUserId: '20' },
    }),
    { createdAt: '2026-07-16T12:00:02.000Z', boardId: 'board_2' },
  );
  assert.equal(value.calls.length, 1);
  assert.match(value.calls[0]?.sql ?? '', /FROM boards b JOIN board_heads/);
  assert.match(value.calls[0]?.sql ?? '', /LIMIT 3$/);
  assert.doesNotMatch(value.calls[0]?.sql ?? '', /scene_payload|COUNT\(/i);
  assert.deepEqual(value.calls[0]?.binds, ['20']);
});

test('grant board page starts from the exact binding key and never performs a per-board policy query', async () => {
  const value = setup('grant');
  const result = await value.service.list({ principal: value.principal, request: request() });
  assert.equal(result.result.type, 'board.list');
  assert.equal(value.calls.length, 1);
  assert.match(value.calls[0]?.sql ?? '', /FROM mcp_grant_boards gb JOIN boards b/);
  assert.match(value.calls[0]?.sql ?? '', /gb\.grant_id = \?/);
  assert.match(value.calls[0]?.sql ?? '', /LIMIT 3$/);
  assert.deepEqual(value.calls[0]?.binds, ['30']);
});

test('API-key board page filters active owner membership and binds its cursor to both owner and key', async () => {
  const value = setup('account_api_key');
  const result = await value.service.list({ principal: value.principal, request: request() });
  assert.equal(result.result.type, 'board.list');
  if (result.result.type !== 'board.list' || result.result.nextCursor === null) return;
  assert.equal(value.calls.length, 1);
  assert.match(value.calls[0]?.sql ?? '', /FROM board_memberships bm JOIN boards b/);
  assert.match(
    value.calls[0]?.sql ?? '',
    /bm\.account_pk = \? AND bm\.role = 'owner' AND bm\.state = 'active' AND b\.owner_user_id = bm\.account_pk/,
  );
  assert.deepEqual(value.calls[0]?.binds, ['20']);
  assert.deepEqual(
    value.cursors.parse({
      cursor: result.result.nextCursor,
      limit: 2,
      includeArchived: false,
      access: {
        accessKind: 'account_api_key',
        ownerUserId: '20',
        apiKeyId: '70',
      },
    }),
    { createdAt: '2026-07-16T12:00:02.000Z', boardId: 'board_2' },
  );
  assert.throws(() =>
    value.cursors.parse({
      cursor: result.result.nextCursor!,
      limit: 2,
      includeArchived: false,
      access: {
        accessKind: 'account_api_key',
        ownerUserId: '20',
        apiKeyId: '71',
      },
    }),
  );
});

test('equal-timestamp pages use the public board ID tuple without duplicates or gaps', async () => {
  const sharedCreatedSecond = 3;
  const value = setup('owner', [
    [
      row('3', sharedCreatedSecond, 'a'),
      row('2', sharedCreatedSecond, 'b'),
      row('1', sharedCreatedSecond, 'c'),
    ],
    [row('1', sharedCreatedSecond, 'c')],
  ]);

  const first = await value.service.list({ principal: value.principal, request: request() });
  assert.equal(first.result.type, 'board.list');
  if (first.result.type !== 'board.list' || first.result.nextCursor === null) return;
  const second = await value.service.list({
    principal: value.principal,
    request: request(first.result.nextCursor),
  });
  assert.equal(second.result.type, 'board.list');
  if (second.result.type !== 'board.list') return;

  assert.deepEqual(
    [...first.result.boards, ...second.result.boards].map((board) => board.boardId),
    ['board_3', 'board_2', 'board_1'],
  );
  assert.equal(second.result.nextCursor, null);
  assert.match(
    value.calls[1]?.sql ?? '',
    /b\.created_at < \? OR \(b\.created_at = \? AND b\.public_id < \?\)/,
  );
  assert.match(value.calls[1]?.sql ?? '', /ORDER BY b\.created_at DESC, b\.public_id DESC/);
  assert.deepEqual(value.calls[1]?.binds, [
    '20',
    '2026-07-16 12:00:03.000',
    '2026-07-16 12:00:03.000',
    'board_2',
  ]);
});
