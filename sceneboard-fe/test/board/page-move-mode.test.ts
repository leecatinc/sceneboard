import assert from 'node:assert/strict';
import test from 'node:test';

import {
  admitPageMovePointerDownV1,
  clampPageMoveXV1,
  classifyPageMoveIntentV1,
  nextPageMoveXV1,
  pageMoveIsAvailableV1,
} from '../../lib/board/page-move-mode.controller';

const admitted = (overrides: Record<string, unknown> = {}) => ({
  moveToggle: true,
  displayMode: 'actual-size' as const,
  pointerActive: false,
  isTrusted: true,
  pointerType: 'touch',
  isPrimary: true,
  button: 0,
  buttons: 1,
  interactivePath: false,
  clientX: 24,
  viewportLeft: 0,
  viewportRight: 320,
  ...overrides,
});

test('move admission enforces explicit actual-size input and the exact 23/24 px edge boundary', () => {
  assert.equal(admitPageMovePointerDownV1(admitted()), true);
  assert.equal(admitPageMovePointerDownV1(admitted({ clientX: 23 })), false);
  for (const rejected of [
    { moveToggle: false },
    { displayMode: 'fit-width' },
    { pointerActive: true },
    { isTrusted: false },
    { pointerType: 'mouse' },
    { isPrimary: false },
    { button: 1 },
    { buttons: 0 },
    { interactivePath: true },
  ])
    assert.equal(admitPageMovePointerDownV1(admitted(rejected)), false);
});

test('axis arbitration keeps 8..11 px pending and locks only at 12 px with a 1.5 ratio', () => {
  assert.equal(classifyPageMoveIntentV1(8, 0), 'pending');
  assert.equal(classifyPageMoveIntentV1(11, 0), 'pending');
  assert.equal(classifyPageMoveIntentV1(12, 8), 'horizontal-locked');
  assert.equal(classifyPageMoveIntentV1(12, 8.01), 'native-yielded');
  assert.equal(classifyPageMoveIntentV1(11, 6), 'native-yielded');
  assert.equal(classifyPageMoveIntentV1(0, 12), 'native-yielded');
});

test('latest absolute pointer coordinate clamps both actual-size edges without accumulating deltas', () => {
  assert.equal(pageMoveIsAvailableV1('actual-size', 320, 800), true);
  assert.equal(pageMoveIsAvailableV1('fit-width', 320, 800), false);
  assert.equal(
    nextPageMoveXV1({
      baseX: -100,
      startClientX: 100,
      latestClientX: 10,
      viewportWidth: 320,
      contentWidth: 800,
    }),
    -190,
  );
  assert.equal(
    nextPageMoveXV1({
      baseX: -100,
      startClientX: 100,
      latestClientX: -900,
      viewportWidth: 320,
      contentWidth: 800,
    }),
    -480,
  );
  assert.equal(clampPageMoveXV1(-10, 900, 800), 0);
});
