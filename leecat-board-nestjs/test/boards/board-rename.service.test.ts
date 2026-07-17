import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { BoardId, PrincipalId } from '@leecat-board/board-schema';

import { BoardRenameService } from '../../src/boards/board-rename.service.js';
import type { BoardAccessPolicy, ResolvedBoardPrincipalV1 } from '../../src/grants/board-access.policy.js';

test('renames one active owner board without creating a scene revision', async () => {
  const boardId = 'board_1' as BoardId;
  const principalId = 'user_1' as PrincipalId;
  const statements: Array<{ sql: string; binds: unknown[] }> = [];
  const connection = {
    execute: async (sql: string, binds: unknown[]) => {
      statements.push({ sql, binds });
      if (sql.includes('UPDATE boards')) return [{ affectedRows: 1 }];
      return [[{ boardId, title: 'Launch plan', updatedAt: '2026-07-18 01:02:03.456' }]];
    },
  };
  const principal: Extract<ResolvedBoardPrincipalV1, { kind: 'user' }> = {
    kind: 'user' as const,
    actor: { principalKind: 'user' as const, principalId, grantId: null, scopes: ['board.read', 'board.write'] },
    userPk: 1n,
    sessionPk: 2n,
    familyPublicId: 'family_1',
  };
  const policy: BoardAccessPolicy = {
    withAuthorizedBoardTransaction: async (input, apply) => {
      assert.deepEqual(input, {
        principal,
        operation: 'board.rename',
        boardId,
        isolation: 'READ_COMMITTED_WRITE',
      });
      return apply(connection as never, {
        actor: principal.actor,
        ownerUserPk: 1n,
        access: { kind: 'owner', ownerUserPk: 1n },
        createBinding: null,
        artifactCapabilityPolicy: { allowedArtifactRequestCapabilities: [], policyEpoch: 'epoch' },
      });
    },
  };

  const result = await new BoardRenameService(policy).rename({
    principal,
    request: { boardId, title: 'Launch plan' as never },
  });

  assert.deepEqual(result, {
    boardId,
    title: 'Launch plan',
    updatedAt: '2026-07-18T01:02:03.456Z',
  });
  assert.equal(statements.length, 2);
  assert.deepEqual(statements[0]?.binds, ['Launch plan', boardId, '1']);
});
