import assert from 'node:assert/strict';
import test from 'node:test';

import type { ArtifactResizeRequestV1 } from '@sceneboard/artifact-runtime/bridge';
import {
  admitArtifactResizeRequestV1,
  advanceArtifactResetEpochV1,
  applyArtifactPanIntentV1,
  changesArtifactSizeV1,
  createArtifactResizeQueueV1,
  takePendingArtifactResizeV1,
} from '../../src/artifact/artifact-host-state.js';
import type { ArtifactHostInputV1 } from '../../src/artifact/ports.js';

const resize = (
  width: number,
  height: number,
  source: 'observer' | 'explicit',
  renderMode?: 'responsive-fixed-canvas',
): ArtifactResizeRequestV1 =>
  renderMode === undefined ? { width, height, source } : { width, height, source, renderMode };

const resetInput = (
  epoch: number,
  hostInstanceId = 'node_a',
  incarnationKey = 'route:node_a:artifact:version',
): ArtifactHostInputV1 =>
  ({
    hostInstanceId: 'node_a',
    incarnationKey: 'route:node_a:artifact:version',
    resetCommand: { hostInstanceId, incarnationKey, epoch },
  }) as unknown as ArtifactHostInputV1;

test('resize admission owns observer-once, explicit precedence, and latest explicit coalescing', () => {
  let queue = createArtifactResizeQueueV1();
  let result = admitArtifactResizeRequestV1(queue, resize(800, 600, 'observer'));
  assert.equal(result.accepted, true);
  queue = result.state;
  assert.equal(admitArtifactResizeRequestV1(queue, resize(801, 601, 'observer')).accepted, false);

  result = admitArtifactResizeRequestV1(queue, resize(1200, 675, 'explicit'));
  assert.equal(result.accepted, true);
  queue = result.state;
  assert.deepEqual(queue.pending, resize(1200, 675, 'explicit'));
  assert.equal(admitArtifactResizeRequestV1(queue, resize(900, 700, 'observer')).accepted, false);

  result = admitArtifactResizeRequestV1(queue, resize(1600, 900, 'explicit'));
  assert.equal(result.accepted, true);
  const taken = takePendingArtifactResizeV1(result.state);
  assert.deepEqual(taken.pending, resize(1600, 900, 'explicit'));
  assert.equal(taken.state.pending, null);

  result = admitArtifactResizeRequestV1(
    taken.state,
    resize(1920, 1080, 'explicit', 'responsive-fixed-canvas'),
  );
  assert.equal(result.accepted, true);
  assert.equal(result.state.pending?.renderMode, 'responsive-fixed-canvas');
});

test('resize admission rejects invalid bounds and equal sizes remain a no-op', () => {
  const queue = createArtifactResizeQueueV1();
  assert.equal(admitArtifactResizeRequestV1(queue, resize(0, 600, 'explicit')).accepted, false);
  assert.equal(
    admitArtifactResizeRequestV1(queue, resize(16_385, 600, 'explicit')).accepted,
    false,
  );
  assert.equal(
    changesArtifactSizeV1({ width: 1200, height: 675 }, resize(1200, 675, 'explicit')),
    false,
  );
  assert.equal(
    changesArtifactSizeV1({ width: 1200, height: 675 }, resize(1201, 675, 'explicit')),
    true,
  );
});

test('reset high-water advances only for newer exact positive safe epochs', () => {
  assert.deepEqual(advanceArtifactResetEpochV1(7, resetInput(8)), { epoch: 8, advanced: true });
  for (const input of [
    resetInput(-1),
    resetInput(0),
    resetInput(Number.MAX_SAFE_INTEGER + 1),
    resetInput(7),
    resetInput(6),
    resetInput(9, 'node_b'),
    resetInput(9, 'node_a', 'route:node_a:sibling:version'),
  ])
    assert.deepEqual(advanceArtifactResetEpochV1(7, input), { epoch: 7, advanced: false });
  assert.deepEqual(
    advanceArtifactResetEpochV1(Number.MAX_SAFE_INTEGER - 1, resetInput(Number.MAX_SAFE_INTEGER)),
    {
      epoch: Number.MAX_SAFE_INTEGER,
      advanced: true,
    },
  );
});

test('pan cancel clears host panning without requesting a transform mutation', () => {
  assert.deepEqual(
    applyArtifactPanIntentV1(true, { type: 'artifact.navigation.pan.cancel', pointerId: 7 }),
    {
      panning: false,
      shouldMove: false,
    },
  );
});
