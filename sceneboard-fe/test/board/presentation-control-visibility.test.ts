import assert from 'node:assert/strict';
import test from 'node:test';

import {
  activityPresentationControlsV1,
  createPresentationControlVisibilityV1,
  elapsePresentationControlsV1,
  PRESENTATION_CONTROL_IDLE_MS,
  updatePresentationControlHoldsV1,
  type PresentationControlVisibilityInputV1,
} from '../../lib/board/presentation-control-visibility';

const clear: PresentationControlVisibilityInputV1 = {
  controlsFocusWithin: false,
  dialogOrMenuOpen: false,
  hitlInteractionActive: false,
  artifactCaptureActive: false,
  moveCaptureActive: false,
  prefersReducedMotion: false,
};

test('controls start hidden, hide at the configured idle deadline, and ignore stale generations', () => {
  assert.equal(createPresentationControlVisibilityV1().phase, 'hidden');
  const pending = activityPresentationControlsV1(
    createPresentationControlVisibilityV1(),
    clear,
    100,
  );
  assert.equal(pending.deadlineMs, 100 + PRESENTATION_CONTROL_IDLE_MS);
  assert.equal(
    elapsePresentationControlsV1(
      pending,
      clear,
      pending.generation,
      100 + PRESENTATION_CONTROL_IDLE_MS - 1,
    ),
    pending,
  );
  const hidden = elapsePresentationControlsV1(
    pending,
    clear,
    pending.generation,
    100 + PRESENTATION_CONTROL_IDLE_MS,
  );
  assert.equal(hidden.phase, 'hidden');
  assert.equal(elapsePresentationControlsV1(hidden, clear, pending.generation, 10_000), hidden);
});

test('every hold reveals immediately and release starts a fresh full timeout', () => {
  const keys = Object.keys(clear) as (keyof PresentationControlVisibilityInputV1)[];
  for (const key of keys) {
    const held = { ...clear, [key]: true };
    const hidden = { phase: 'hidden', generation: 4, deadlineMs: null } as const;
    const visible = updatePresentationControlHoldsV1(hidden, clear, held, 500);
    assert.equal(visible.phase, 'visible', key);
    assert.equal(visible.deadlineMs, null, key);
    const released = updatePresentationControlHoldsV1(visible, held, clear, 900);
    assert.equal(released.phase, 'pending-hide', key);
    assert.equal(released.deadlineMs, 900 + PRESENTATION_CONTROL_IDLE_MS, key);
  }
});
