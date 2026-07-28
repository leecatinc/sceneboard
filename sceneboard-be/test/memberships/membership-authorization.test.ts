import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { PoolConnection } from 'mysql2/promise';

import {
  membershipPolicyFor,
  roleCanPerformBoardOperation,
} from '../../src/memberships/membership-capability.matrix.js';
import { MembershipRepository } from '../../src/memberships/membership.repository.js';
import {
  BoardMembershipAuthorizationService,
  MembershipAuthorizationDeniedError,
} from '../../src/memberships/membership.service.js';

const connection = {} as PoolConnection;

test('browser and MCP share one exact matrix and unknown identifiers fail closed', () => {
  assert.equal(roleCanPerformBoardOperation('viewer', 'board.get', 'browser'), true);
  assert.equal(roleCanPerformBoardOperation('viewer', 'board.get', 'mcp'), true);
  assert.equal(roleCanPerformBoardOperation('viewer', 'history.get', 'browser'), false);
  assert.equal(roleCanPerformBoardOperation('editor', 'board.archive', 'mcp'), false);
  assert.equal(roleCanPerformBoardOperation('owner', 'membership.invite', 'browser'), true);
  assert.equal(membershipPolicyFor('membership.invite', 'mcp'), null);
  assert.equal(membershipPolicyFor('board.anything', 'browser'), null);
});

test('write authorization captures and rechecks the exact membership version and role', async () => {
  let row = {
    membershipPk: 7n,
    boardPk: 11n,
    accountPk: 13n,
    role: 'editor' as const,
    version: 4,
  };
  const repository = {
    findActive: async () => row,
    adoptCanonicalOwner: async () => undefined,
    createOwner: async () => undefined,
  } as unknown as MembershipRepository;
  const service = new BoardMembershipAuthorizationService(repository);
  const context = await service.authorize(connection, {
    boardPk: 11n,
    canonicalOwnerAccountPk: 17n,
    accountPk: 13n,
    operation: 'scene.restore',
    surface: 'browser',
    write: true,
  });
  assert.equal(context.membershipRole, 'editor');
  assert.equal(context.membershipVersion, 4);
  await service.recheck(connection, context);

  row = { ...row, version: 5 };
  await assert.rejects(
    () => service.recheck(connection, context),
    MembershipAuthorizationDeniedError,
  );
});

test('first membership lock wins: writer-first completes, role-change-first denies before effects', async () => {
  let role: 'editor' | 'viewer' = 'editor';
  const effects: string[] = [];
  const repository = {
    findActive: async () => ({
      membershipPk: 7n,
      boardPk: 11n,
      accountPk: 13n,
      role,
      version: role === 'editor' ? 4 : 5,
    }),
    adoptCanonicalOwner: async () => undefined,
    createOwner: async () => undefined,
  } as unknown as MembershipRepository;
  const service = new BoardMembershipAuthorizationService(repository);
  const writer = await service.authorize(connection, {
    boardPk: 11n,
    canonicalOwnerAccountPk: 17n,
    accountPk: 13n,
    operation: 'scene.restore',
    surface: 'mcp',
    write: true,
  });
  effects.push('revision', 'idempotency', 'outbox');
  await service.recheck(connection, writer);
  role = 'viewer';
  assert.deepEqual(effects, ['revision', 'idempotency', 'outbox']);

  const deniedEffects: string[] = [];
  await assert.rejects(async () => {
    await service.authorize(connection, {
      boardPk: 11n,
      canonicalOwnerAccountPk: 17n,
      accountPk: 13n,
      operation: 'scene.restore',
      surface: 'mcp',
      write: true,
    });
    deniedEffects.push('revision');
  }, MembershipAuthorizationDeniedError);
  assert.deepEqual(deniedEffects, []);
});

test('capability epoch drift denies a precommit authorization without revoking the account session', async () => {
  const repository = {
    findActive: async () => ({
      membershipPk: 7n,
      boardPk: 11n,
      accountPk: 13n,
      role: 'editor' as const,
      version: 4,
    }),
    adoptCanonicalOwner: async () => undefined,
    createOwner: async () => undefined,
  } as unknown as MembershipRepository;
  const epochConnection = {
    execute: async () => [[{ capabilityEpoch: '8' }]],
  } as unknown as PoolConnection;
  const service = new BoardMembershipAuthorizationService(repository);
  const context = await service.authorize(epochConnection, {
    boardPk: 11n,
    canonicalOwnerAccountPk: 17n,
    accountPk: 13n,
    capabilityEpoch: 7,
    operation: 'scene.replace',
    surface: 'mcp',
    write: true,
  });
  await assert.rejects(
    () => service.recheck(epochConnection, context),
    MembershipAuthorizationDeniedError,
  );
  assert.equal(context.accountPk, 13n);
});
