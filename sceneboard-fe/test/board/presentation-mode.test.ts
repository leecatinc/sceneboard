import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createPresentationLifecycleStateV1,
  presentationSettlementIsCurrentV1,
  reducePresentationLifecycleV1,
  samePresentationIdentityV1,
} from '../../lib/board/presentation-mode.controller';

const identity = (requestEpoch: number, pageElementEpoch = 1) => ({
  boardId: 'board-1',
  revisionId: 'revision-1',
  routeEpoch: 'board-1:revision-1',
  pageElementEpoch,
  requestEpoch,
});

test('presentation lifecycle ignores overlapping stale request and PAGE epochs', () => {
  const requestA = identity(1);
  const requestB = identity(2);
  let state = reducePresentationLifecycleV1(createPresentationLifecycleStateV1(), {
    type: 'enter',
    identity: requestA,
  });
  state = reducePresentationLifecycleV1(state, { type: 'enter', identity: requestB });
  assert.equal(
    reducePresentationLifecycleV1(state, {
      type: 'fullscreen-entered',
      identity: requestA,
    }),
    state,
  );
  state = reducePresentationLifecycleV1(state, {
    type: 'fallback-focus',
    identity: requestB,
  });
  assert.equal(state.mode, 'focus');
  assert.equal(
    reducePresentationLifecycleV1(state, {
      type: 'matching-exit',
      identity: identity(2, 2),
    }),
    state,
  );
});

test('matching fullscreen and forced exit transition while invalidation clears identity', () => {
  const current = identity(7);
  let state = reducePresentationLifecycleV1(createPresentationLifecycleStateV1(), {
    type: 'enter',
    identity: current,
  });
  state = reducePresentationLifecycleV1(state, {
    type: 'fullscreen-entered',
    identity: current,
  });
  assert.equal(state.mode, 'fullscreen');
  state = reducePresentationLifecycleV1(state, { type: 'matching-exit', identity: current });
  assert.deepEqual(state, createPresentationLifecycleStateV1());
  assert.equal(samePresentationIdentityV1(current, { ...current, requestEpoch: 8 }), false);
});

test('fullscreen settlement requires exact identity and the same connected PAGE element', () => {
  const current = identity(9);
  const page = { isConnected: true } as unknown as Element;
  const replacement = { isConnected: true } as unknown as Element;

  assert.equal(
    presentationSettlementIsCurrentV1({
      expected: current,
      current,
      capturedPage: page,
      currentPage: page,
    }),
    true,
  );
  assert.equal(
    presentationSettlementIsCurrentV1({
      expected: current,
      current: identity(10),
      capturedPage: page,
      currentPage: page,
    }),
    false,
  );
  assert.equal(
    presentationSettlementIsCurrentV1({
      expected: current,
      current,
      capturedPage: page,
      currentPage: replacement,
    }),
    false,
  );
  assert.equal(
    presentationSettlementIsCurrentV1({
      expected: current,
      current,
      capturedPage: { isConnected: false } as unknown as Element,
      currentPage: page,
    }),
    false,
  );
});
