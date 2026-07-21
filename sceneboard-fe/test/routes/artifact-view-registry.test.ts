import assert from 'node:assert/strict';
import test from 'node:test';

import {
  canResetArtifactViewV1,
  createArtifactViewRegistryV1,
  reduceArtifactViewRegistryV1,
  selectedArtifactZoomV1,
} from '../../lib/board/artifact-view-registry';

const event = (
  hostInstanceId: string,
  incarnationKey: string,
  phase: 'register' | 'interaction' | 'unregister',
  scale = 1,
) => ({ hostInstanceId, incarnationKey, phase, scale }) as const;

test('selects first registration, last interaction, and oldest surviving fallback', () => {
  let state = createArtifactViewRegistryV1();
  state = reduceArtifactViewRegistryV1(state, {
    type: 'event',
    event: event('node_a', 'one', 'register'),
  });
  state = reduceArtifactViewRegistryV1(state, {
    type: 'event',
    event: event('node_b', 'two', 'register'),
  });
  assert.equal(state.selectedHostInstanceId, 'node_a');
  state = reduceArtifactViewRegistryV1(state, {
    type: 'event',
    event: event('node_b', 'two', 'interaction', 1.25),
  });
  assert.equal(state.selectedHostInstanceId, 'node_b');
  assert.equal(selectedArtifactZoomV1(state), 1.25);
  state = reduceArtifactViewRegistryV1(state, {
    type: 'event',
    event: event('node_b', 'two', 'unregister', 1.25),
  });
  assert.equal(state.selectedHostInstanceId, 'node_a');
});

test('ignores stale incarnations and targets a monotonic reset command', () => {
  let state = createArtifactViewRegistryV1();
  state = reduceArtifactViewRegistryV1(state, {
    type: 'event',
    event: event('node_a', 'old', 'register'),
  });
  state = reduceArtifactViewRegistryV1(state, {
    type: 'event',
    event: event('node_a', 'new', 'register', 2),
  });
  state = reduceArtifactViewRegistryV1(state, {
    type: 'event',
    event: event('node_a', 'old', 'unregister'),
  });
  assert.equal(state.entries.get('node_a')?.incarnationKey, 'new');
  state = reduceArtifactViewRegistryV1(state, { type: 'reset' });
  assert.deepEqual(state.resetCommand, {
    hostInstanceId: 'node_a',
    incarnationKey: 'new',
    epoch: 1,
  });
  state = reduceArtifactViewRegistryV1(state, {
    type: 'event',
    event: event('node_a', 'new', 'interaction'),
  });
  assert.equal(state.resetCommand, null);
});

test('replacing one host cannot consume a sibling reset command', () => {
  let state = createArtifactViewRegistryV1();
  state = reduceArtifactViewRegistryV1(state, {
    type: 'event',
    event: event('node_a', 'a_old', 'register'),
  });
  state = reduceArtifactViewRegistryV1(state, {
    type: 'event',
    event: event('node_b', 'b_one', 'register'),
  });
  state = reduceArtifactViewRegistryV1(state, {
    type: 'event',
    event: event('node_b', 'b_one', 'interaction'),
  });
  state = reduceArtifactViewRegistryV1(state, { type: 'reset' });
  const command = state.resetCommand;
  state = reduceArtifactViewRegistryV1(state, {
    type: 'event',
    event: event('node_a', 'a_new', 'register'),
  });
  assert.deepEqual(state.resetCommand, command);
  state = reduceArtifactViewRegistryV1(state, {
    type: 'event',
    event: event('node_b', 'b_two', 'register'),
  });
  assert.equal(state.resetCommand, null);
});

test('clears route state and leaves unavailable zoom empty', () => {
  let state = createArtifactViewRegistryV1();
  state = reduceArtifactViewRegistryV1(state, {
    type: 'event',
    event: event('node_a', 'one', 'register'),
  });
  state = reduceArtifactViewRegistryV1(state, { type: 'reset' });
  const epoch = state.resetEpoch;
  state = reduceArtifactViewRegistryV1(state, { type: 'clear' });
  assert.equal(state.entries.size, 0);
  assert.equal(selectedArtifactZoomV1(state), null);
  assert.equal(state.resetEpoch, epoch);
  assert.equal(canResetArtifactViewV1(state), false);
});

test('MAX reset epoch fails closed without wrap or route-clear reuse', () => {
  let state = createArtifactViewRegistryV1();
  state = reduceArtifactViewRegistryV1(state, {
    type: 'event',
    event: event('node_a', 'one', 'register'),
  });
  state = { ...state, resetEpoch: Number.MAX_SAFE_INTEGER - 1 };
  state = reduceArtifactViewRegistryV1(state, { type: 'reset' });
  assert.equal(state.resetEpoch, Number.MAX_SAFE_INTEGER);
  assert.deepEqual(state.resetCommand, {
    hostInstanceId: 'node_a',
    incarnationKey: 'one',
    epoch: Number.MAX_SAFE_INTEGER,
  });
  assert.equal(canResetArtifactViewV1(state), false);

  const saturated = reduceArtifactViewRegistryV1(state, { type: 'reset' });
  assert.equal(saturated, state);
  const cleared = reduceArtifactViewRegistryV1(saturated, { type: 'clear' });
  assert.equal(cleared.resetEpoch, Number.MAX_SAFE_INTEGER);
  assert.equal(canResetArtifactViewV1(cleared), false);
  assert.equal(reduceArtifactViewRegistryV1(cleared, { type: 'reset' }), cleared);
});
