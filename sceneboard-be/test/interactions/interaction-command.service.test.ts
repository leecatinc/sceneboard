import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BoardContractError } from '../../src/common/errors/app-error.js';
import { InteractionCommandService } from '../../src/interactions/application/interaction-command.service.js';
import { HitlWaitCoordinator } from '../../src/interactions/application/hitl-wait-coordinator.js';

const userPrincipal = {
  kind: 'user',
  actor: {
    principalKind: 'user',
    principalId: 'user_1',
    grantId: null,
    scopes: ['board.hitl.request', 'board.read'],
  },
  userPk: 1n,
  sessionPk: 2n,
  familyPublicId: 'family_1',
} as const;

const context = {
  actor: userPrincipal.actor,
  ownerUserPk: 1n,
  access: { kind: 'owner', ownerUserPk: 1n },
  createBinding: null,
  artifactCapabilityPolicy: { allowedArtifactRequestCapabilities: [], policyEpoch: 'epoch' },
} as const;

test('commits request creation with one event and a service-owned fifteen-minute expiry', async () => {
  const calls: string[] = [];
  let createdAt = '';
  let expiresAt = '';
  const access = {
    withAuthorizedBoardTransaction: async (
      _input: unknown,
      apply: (connection: never, value: never) => Promise<unknown>,
    ) => {
      calls.push('authorized');
      return apply({} as never, context as never);
    },
  };
  const interactions = {
    create: async (
      _connection: unknown,
      input: {
        hitlRequestId: string;
        definition: unknown;
        createdAt: string;
        expiresAt: string;
      },
    ) => {
      calls.push('interaction');
      createdAt = input.createdAt;
      expiresAt = input.expiresAt;
      return {
        hitlRequestId: input.hitlRequestId,
        definition: input.definition,
        state: 'open',
        createdAt: input.createdAt,
        expiresAt: input.expiresAt,
        stateUpdatedAt: input.createdAt,
        response: null,
        answeredAt: null,
      };
    },
  };
  const mutations = {
    begin: async () => {
      calls.push('idempotency');
      return { kind: 'new', recordPk: 1n };
    },
    lockHead: async () => {
      calls.push('head');
      return {
        boardPk: '1',
        headRevisionPk: '2',
        headRevisionId: 'revision_1',
        headRevisionNumber: 1,
        lastEventSequence: 0,
      };
    },
    allocateSequence: async () => {
      calls.push('sequence');
      return 1;
    },
    appendEvent: async () => {
      calls.push('event');
    },
    complete: async (
      _connection: unknown,
      _pk: unknown,
      _head: unknown,
      _prepared: unknown,
      value: unknown,
    ) => {
      calls.push('complete');
      return value;
    },
  };
  const service = new InteractionCommandService(
    access as never,
    interactions as never,
    mutations as never,
    {
      expireLocked: async () => {
        throw new Error('unexpected expiry');
      },
    } as never,
    new HitlWaitCoordinator(),
    {
      writeSuccess: async () => {
        calls.push('audit');
      },
    } as never,
    () => new Date('2026-07-16T00:00:00.000Z'),
  );
  const result = await service.apply({
    principal: userPrincipal as never,
    request: {
      protocolVersion: 1,
      requestId: 'request_1',
      idempotencyKey: 'idempotency-key-1',
      boardId: 'board_1',
      expectedRevisionId: 'revision_1',
      command: {
        type: 'hitl.request',
        hitlRequestId: 'hitl_1',
        request: { kind: 'info', title: 'Info', body: 'Read', acknowledgeLabel: 'OK' },
      },
    } as never,
  });
  assert.deepEqual(calls, [
    'authorized',
    'idempotency',
    'head',
    'sequence',
    'interaction',
    'event',
    'complete',
    'audit',
  ]);
  assert.equal(createdAt, '2026-07-16T00:00:00.000Z');
  assert.equal(expiresAt, '2026-07-16T00:15:00.000Z');
  assert.equal(result.result.type, 'hitl.request');
  assert.equal(result.eventIds.length, 1);
});

test('rejects destructive positive confirmation from MCP before sequence or response persistence', async () => {
  let sequenceCalls = 0;
  let answerCalls = 0;
  const principal = {
    kind: 'mcp',
    actor: {
      principalKind: 'mcp_client',
      principalId: 'client_1',
      grantId: 'grant_1',
      scopes: ['board.hitl.respond', 'board.read'],
    },
    ownerUserPk: 1n,
    grantPk: 2n,
    credentialPk: 3n,
    grantId: 'grant_1',
    sourceFamilyPublicId: null,
  } as const;
  const mcpContext = {
    ...context,
    actor: principal.actor,
    access: { kind: 'grant', grantPk: 2n, grantId: 'grant_1' },
  };
  const stored = {
    hitlPk: '5',
    boardPk: '1',
    interaction: {
      hitlRequestId: 'hitl_1',
      definition: {
        kind: 'confirmation',
        title: 'Delete',
        body: 'Irreversible',
        impact: 'destructive',
        confirmLabel: 'Delete',
        cancelLabel: 'Keep',
      },
      state: 'open',
      createdAt: '2026-07-16T00:00:00.000Z',
      expiresAt: '2026-07-16T00:15:00.000Z',
      stateUpdatedAt: '2026-07-16T00:00:00.000Z',
      response: null,
      answeredAt: null,
    },
    createdByKind: 'M',
    createdByPrincipalId: 'client_1',
    createdByGrantId: 'grant_1',
    supersededByRequestId: null,
    createdEventSequence: 1,
    stateEventSequence: 1,
  };
  const access = {
    withAuthorizedBoardTransaction: async (
      _input: unknown,
      apply: (connection: never, value: never) => Promise<unknown>,
    ) => apply({} as never, mcpContext as never),
  };
  const interactions = {
    lockByBoardPk: async () => stored,
    answer: async () => {
      answerCalls += 1;
    },
  };
  const mutations = {
    begin: async () => ({ kind: 'new', recordPk: 1n }),
    lockHead: async () => ({
      boardPk: '1',
      headRevisionPk: '2',
      headRevisionId: 'revision_1',
      headRevisionNumber: 1,
      lastEventSequence: 1,
    }),
    allocateSequence: async () => {
      sequenceCalls += 1;
      return 2;
    },
  };
  const service = new InteractionCommandService(
    access as never,
    interactions as never,
    mutations as never,
    {
      expireLocked: async () => {
        throw new Error('unexpected expiry');
      },
    } as never,
    new HitlWaitCoordinator(),
    { writeSuccess: async () => undefined } as never,
    () => new Date('2026-07-16T00:01:00.000Z'),
  );
  await assert.rejects(
    service.apply({
      principal: principal as never,
      request: {
        protocolVersion: 1,
        requestId: 'request_2',
        idempotencyKey: 'idempotency-key-2',
        boardId: 'board_1',
        expectedRevisionId: 'revision_1',
        command: {
          type: 'hitl.respond',
          hitlRequestId: 'hitl_1',
          response: { kind: 'confirmation', confirmed: true },
        },
      } as never,
    }),
    (error: unknown) =>
      error instanceof BoardContractError && error.boardError.code === 'FORBIDDEN',
  );
  assert.equal(sequenceCalls, 0);
  assert.equal(answerCalls, 0);
});

test('commits authoritative expiry and deletes pending respond idempotency before returning 410', async () => {
  const calls: string[] = [];
  const stored = {
    hitlPk: '5',
    boardPk: '1',
    interaction: {
      hitlRequestId: 'hitl_1',
      definition: { kind: 'info', title: 'Info', body: 'Read', acknowledgeLabel: 'OK' },
      state: 'open',
      createdAt: '2026-07-16T00:00:00.000Z',
      expiresAt: '2026-07-16T00:15:00.000Z',
      stateUpdatedAt: '2026-07-16T00:00:00.000Z',
      response: null,
      answeredAt: null,
    },
    createdByKind: 'U',
    createdByPrincipalId: 'user_1',
    createdByGrantId: null,
    supersededByRequestId: null,
    createdEventSequence: 1,
    stateEventSequence: 1,
  } as const;
  const access = {
    withAuthorizedBoardTransaction: async (
      _input: unknown,
      apply: (connection: never, value: never) => Promise<unknown>,
    ) => {
      const value = await apply({} as never, context as never);
      calls.push('commit');
      return value;
    },
  };
  const mutations = {
    begin: async () => {
      calls.push('idempotency');
      return { kind: 'new', recordPk: 9n };
    },
    lockHead: async () => {
      calls.push('head');
      return {
        boardPk: '1',
        headRevisionPk: '2',
        headRevisionId: 'revision_1',
        headRevisionNumber: 1,
        lastEventSequence: 1,
      };
    },
    abandonPending: async (_connection: unknown, recordPk: bigint) => {
      assert.equal(recordPk, 9n);
      calls.push('abandon');
    },
  };
  const expiry = {
    expireLocked: async (_connection: unknown, input: { stored: typeof stored }) => {
      assert.equal(input.stored, stored);
      calls.push('expiry');
      return {
        ...stored.interaction,
        state: 'expired',
        stateUpdatedAt: stored.interaction.expiresAt,
      };
    },
  };
  const service = new InteractionCommandService(
    access as never,
    { lockByBoardPk: async () => stored } as never,
    mutations as never,
    expiry as never,
    new HitlWaitCoordinator(),
    { writeSuccess: async () => undefined } as never,
    () => new Date('2026-07-16T00:15:00.000Z'),
  );
  await assert.rejects(
    service.apply({
      principal: userPrincipal as never,
      request: {
        protocolVersion: 1,
        requestId: 'request_3',
        idempotencyKey: 'idempotency-key-3',
        boardId: 'board_1',
        expectedRevisionId: 'revision_1',
        command: {
          type: 'hitl.respond',
          hitlRequestId: 'hitl_1',
          response: { kind: 'info', acknowledged: true },
        },
      } as never,
    }),
    (error: unknown) =>
      error instanceof BoardContractError &&
      error.boardError.code === 'HITL_REQUEST_EXPIRED' &&
      error.boardError.httpStatusHint === 410,
  );
  assert.deepEqual(calls, ['idempotency', 'head', 'expiry', 'abandon', 'commit']);
});
