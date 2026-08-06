import assert from 'node:assert/strict';
import test from 'node:test';

import { shouldUseCurrentTabForPresentationSample } from '../../lib/landing/presentation-sample-navigation';

test('touch users open the presentation sample in the current tab', () => {
  assert.equal(
    shouldUseCurrentTabForPresentationSample({
      isPrimaryClick: true,
      hasModifierKey: false,
      activationSource: 'touch',
    }),
    true,
  );
});

test('desktop and explicit alternate-navigation gestures preserve the new-tab link behavior', () => {
  const alternateNavigationInputs = [
    { isPrimaryClick: true, hasModifierKey: false, activationSource: 'mouse' },
    { isPrimaryClick: true, hasModifierKey: true, activationSource: 'touch' },
    { isPrimaryClick: false, hasModifierKey: false, activationSource: 'touch' },
  ] as const;

  for (const input of alternateNavigationInputs)
    assert.equal(shouldUseCurrentTabForPresentationSample(input), false);
});

test('mouse and keyboard activations stay native even on touch-capable devices', () => {
  for (const activationSource of ['mouse', 'keyboard'] as const)
    assert.equal(
      shouldUseCurrentTabForPresentationSample({
        isPrimaryClick: true,
        hasModifierKey: false,
        activationSource,
      }),
      false,
    );
});
