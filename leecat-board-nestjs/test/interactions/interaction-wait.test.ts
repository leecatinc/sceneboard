import assert from 'node:assert/strict';
import { test } from 'node:test';

import { HitlWaitCoordinator } from '../../src/interactions/application/hitl-wait-coordinator.js';
import { InteractionQueryService } from '../../src/interactions/application/interaction-query.service.js';

const open = {
  hitlPk: '7',
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

test('wait releases every authorization callback before sleeping and wakes on local commit notification', async () => {
  let activeTransactions = 0;
  let maximumActive = 0;
  let stored: unknown = open;
  const access = {
    withAuthorizedBoardTransaction: async (_input: unknown, apply: (connection: never) => Promise<unknown>) => {
      activeTransactions += 1;
      maximumActive = Math.max(maximumActive, activeTransactions);
      try {
        return await apply({} as never);
      } finally {
        activeTransactions -= 1;
      }
    },
  };
  const interactions = { readByPublicId: async () => stored };
  const expiry = { expireForAuthorizedRead: async () => { throw new Error('not due'); } };
  const waits = new HitlWaitCoordinator();
  const service = new InteractionQueryService(
    access as never, interactions as never, expiry as never, waits,
    () => Date.parse('2026-07-16T00:01:00.000Z'),
  );
  const pending = service.read({} as never, {
    protocolVersion: 1,
    requestId: 'request_1' as never,
    type: 'hitl.read',
    boardId: 'board_1' as never,
    hitlRequestId: 'hitl_1' as never,
    wait: { afterStateUpdatedAt: '2026-07-16T00:00:00.000Z' as never, timeoutMs: 2_000 },
  }, new AbortController().signal);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(activeTransactions, 0);
  stored = {
    ...open,
    stateEventSequence: 2,
    interaction: {
      ...open.interaction,
      state: 'answered',
      stateUpdatedAt: '2026-07-16T00:01:00.000Z',
      response: { kind: 'info', acknowledged: true },
      answeredAt: '2026-07-16T00:01:00.000Z',
    },
  };
  waits.notify('board_1\0hitl_1');
  const response = await pending;
  assert.equal(response.result.type, 'hitl.read');
  if (response.result.type === 'hitl.read') {
    assert.equal(response.result.changed, true);
    assert.equal(response.result.hitl.state, 'answered');
  }
  assert.equal(activeTransactions, 0);
  assert.equal(maximumActive, 1);
});

test('abort removes a waiter and rejects without a later notification mutation', async () => {
  const waits = new HitlWaitCoordinator();
  const abort = new AbortController();
  const pending = waits.wait('board_1\0hitl_1', 0, 5_000, abort.signal);
  abort.abort(new DOMException('Aborted', 'AbortError'));
  await assert.rejects(pending, (error: unknown) => error instanceof DOMException && error.name === 'AbortError');
  waits.notify('board_1\0hitl_1');
});
