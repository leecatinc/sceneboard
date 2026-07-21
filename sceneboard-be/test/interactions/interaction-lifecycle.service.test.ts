import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BoardContractError } from '../../src/common/errors/app-error.js';
import { InteractionLifecycleService } from '../../src/interactions/application/interaction-lifecycle.service.js';
import { HitlWaitCoordinator } from '../../src/interactions/application/hitl-wait-coordinator.js';
import type { StoredInteractionV1 } from '../../src/interactions/persistence/interaction-row.mapper.js';

const EVENT_ID = '123e4567-e89b-42d3-a456-426614174000';

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

const openStored = (
  hitlRequestId: string,
  createdAt: string,
  hitlPk: string,
): StoredInteractionV1 =>
  ({
    hitlPk,
    boardPk: '1',
    interaction: {
      hitlRequestId,
      definition: { kind: 'info', title: 'Info', body: 'Read', acknowledgeLabel: 'OK' },
      state: 'open' as const,
      createdAt,
      expiresAt: '2026-07-16T00:15:00.000Z',
      stateUpdatedAt: createdAt,
      response: null,
      answeredAt: null,
    },
    createdByKind: 'U' as const,
    createdByPrincipalId: 'user_1',
    createdByGrantId: null,
    supersededByRequestId: null as string | null,
    createdEventSequence: 1,
    stateEventSequence: 1,
  }) as never;

const access = {
  withAuthorizedBoardTransaction: async (
    _input: unknown,
    apply: (connection: never, value: never) => Promise<unknown>,
  ) => apply({} as never, context as never),
};

test('cancels once and replays the original cursor/event without a second transition', async () => {
  const stored = openStored('hitl_1', '2026-07-16T00:00:00.000Z', '5');
  let transitions = 0;
  let sequences = 0;
  const interactions = {
    lockByBoardPk: async () => stored,
    cancel: async () => {
      transitions += 1;
      stored.interaction = {
        ...stored.interaction,
        state: 'cancelled' as const,
        stateUpdatedAt: '2026-07-16T00:01:00.000Z' as never,
      };
      stored.stateEventSequence = 2;
    },
  };
  const mutations = {
    lockHeadForExpected: async () => ({
      boardPk: '1',
      headRevisionPk: '2',
      headRevisionId: 'revision_1',
      headRevisionNumber: 1,
      lastEventSequence: 1,
    }),
    allocateSequenceAt: async () => {
      sequences += 1;
      return 2;
    },
    appendEvent: async () => undefined,
    eventIdAtSequence: async (_connection: unknown, _boardPk: string, sequence: number) => {
      assert.equal(sequence, 2);
      return EVENT_ID;
    },
  };
  const service = new InteractionLifecycleService(
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
    () => EVENT_ID,
  );
  const input = {
    principal: userPrincipal as never,
    boardId: 'board_1',
    hitlRequestId: 'hitl_1',
    request: {
      protocolVersion: 1,
      requestId: 'request_cancel_1',
      expectedRevisionId: 'revision_1',
      expectedStateUpdatedAt: '2026-07-16T00:00:00.000Z',
    },
  } as never;
  const first = await service.cancel(input);
  const replay = await service.cancel(input);
  assert.equal(first.replayed, false);
  assert.equal(replay.replayed, true);
  assert.deepEqual(first.eventIds, [EVENT_ID]);
  assert.deepEqual(replay.eventIds, [EVENT_ID]);
  assert.equal(transitions, 1);
  assert.equal(sequences, 1);
});

test('supersedes with one newer open successor and hides a different stored successor on conflict', async () => {
  const predecessor = openStored('hitl_1', '2026-07-16T00:00:00.000Z', '5');
  const successor = openStored('hitl_2', '2026-07-16T00:00:30.000Z', '6');
  const alternative = openStored('hitl_3', '2026-07-16T00:00:40.000Z', '7');
  let transitions = 0;
  const interactions = {
    lockPairByBoardPk: async (
      _connection: unknown,
      _boardPk: string,
      _first: string,
      second: string,
    ) => [predecessor, second === 'hitl_2' ? successor : alternative],
    supersede: async () => {
      transitions += 1;
      predecessor.interaction = {
        ...predecessor.interaction,
        state: 'superseded' as const,
        stateUpdatedAt: '2026-07-16T00:01:00.000Z' as never,
      };
      predecessor.supersededByRequestId = 'hitl_2' as never;
      predecessor.stateEventSequence = 2;
    },
  };
  const mutations = {
    lockHeadForExpected: async () => ({
      boardPk: '1',
      headRevisionPk: '2',
      headRevisionId: 'revision_1',
      headRevisionNumber: 1,
      lastEventSequence: 1,
    }),
    allocateSequenceAt: async () => 2,
    appendEvent: async () => undefined,
    eventIdAtSequence: async () => EVENT_ID,
  };
  const service = new InteractionLifecycleService(
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
    () => EVENT_ID,
  );
  const first = await service.supersede({
    principal: userPrincipal,
    boardId: 'board_1',
    hitlRequestId: 'hitl_1',
    request: {
      protocolVersion: 1,
      requestId: 'request_supersede_1',
      expectedRevisionId: 'revision_1',
      expectedStateUpdatedAt: '2026-07-16T00:00:00.000Z',
      successorHitlRequestId: 'hitl_2',
    },
  } as never);
  assert.equal(first.hitl.state, 'superseded');
  await assert.rejects(
    service.supersede({
      principal: userPrincipal,
      boardId: 'board_1',
      hitlRequestId: 'hitl_1',
      request: {
        protocolVersion: 1,
        requestId: 'request_supersede_2',
        expectedRevisionId: 'revision_1',
        expectedStateUpdatedAt: '2026-07-16T00:00:00.000Z',
        successorHitlRequestId: 'hitl_3',
      },
    } as never),
    (error: unknown) => {
      if (!(error instanceof BoardContractError)) return false;
      assert.equal(error.boardError.code, 'HITL_RESPONSE_CONFLICT');
      assert.deepEqual(error.boardError.details, { hitlRequestId: 'hitl_1', state: 'superseded' });
      assert.equal(JSON.stringify(error.boardError).includes('hitl_2'), false);
      return true;
    },
  );
  assert.equal(transitions, 1);
});
