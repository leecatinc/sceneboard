import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  BOARD_AUTHORIZATION_CAPABILITIES_V1,
  BOARD_AUTHORIZATION_OPERATION_TYPES_V1,
  BOARD_OPERATION_AUTHORIZATION_MATRIX_V1,
  BoardAuthorizationPrincipalParserV1,
  BoardMembershipParserV1,
  BoardOperationAuthorizationMatrixParserV1,
} from '../src/index.js';

test('authorization matrix exactly covers the closed operation catalog', () => {
  const parsed = BoardOperationAuthorizationMatrixParserV1.parse(
    BOARD_OPERATION_AUTHORIZATION_MATRIX_V1,
  );
  assert.equal(parsed.ok, true);
  assert.deepEqual(
    BOARD_OPERATION_AUTHORIZATION_MATRIX_V1.map((row) => row.operation),
    BOARD_AUTHORIZATION_OPERATION_TYPES_V1,
  );
  assert.equal(
    new Set(BOARD_OPERATION_AUTHORIZATION_MATRIX_V1.map((row) => row.operation)).size,
    BOARD_AUTHORIZATION_OPERATION_TYPES_V1.length,
  );
  for (const row of BOARD_OPERATION_AUTHORIZATION_MATRIX_V1) {
    assert.ok(row.requiredCapabilities.length > 0);
    assert.ok(
      row.requiredCapabilities.every((item) => BOARD_AUTHORIZATION_CAPABILITIES_V1.includes(item)),
    );
  }
});

test('owner, editor, and viewer decisions are exhaustive and least-privilege', () => {
  const byOperation = new Map(
    BOARD_OPERATION_AUTHORIZATION_MATRIX_V1.map((row) => [row.operation, row]),
  );
  assert.deepEqual(byOperation.get('board.get')?.roles, {
    owner: true,
    editor: true,
    viewer: true,
  });
  assert.deepEqual(byOperation.get('history.get')?.roles, {
    owner: true,
    editor: true,
    viewer: false,
  });
  assert.deepEqual(byOperation.get('board.archive')?.roles, {
    owner: true,
    editor: false,
    viewer: false,
  });
  assert.equal(byOperation.get('artifact.get')?.viewerResourceScope, 'current_head');
  assert.equal(byOperation.get('hitl.read')?.viewerResourceScope, 'current_head');
  assert.equal(byOperation.has('unknown.operation' as never), false);
});

test('membership and share-viewer principals are strict and cannot be confused', () => {
  const membership = BoardMembershipParserV1.parse({
    protocolVersion: 1,
    type: 'board.membership',
    membershipId: 'membership_1',
    boardId: 'board_1',
    accountId: 'account_1',
    role: 'editor',
    state: 'active',
    version: 2,
    createdAt: '2026-07-28T00:00:00.000Z',
    updatedAt: '2026-07-28T00:00:01.000Z',
  });
  assert.equal(membership.ok, true);
  assert.equal(
    BoardAuthorizationPrincipalParserV1.parse({
      kind: 'share_viewer',
      shareId: 'share_1',
    }).ok,
    true,
  );
  assert.equal(
    BoardAuthorizationPrincipalParserV1.parse({
      kind: 'share_viewer',
      shareId: 'share_1',
      accountId: 'account_1',
    }).ok,
    false,
  );
});
