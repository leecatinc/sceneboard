import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createResponsivePageChoiceV1,
  resizeResponsivePageChoiceV1,
  responsivePageClassV1,
  selectResponsivePageModeV1,
} from '../../lib/board/responsive-page-mode';

test('760/761 chooses fit-width/fit-page only while the choice is implicit', () => {
  assert.equal(responsivePageClassV1(760), 'mobile');
  assert.equal(responsivePageClassV1(761), 'desktop');
  let choice = createResponsivePageChoiceV1('board-1', 760);
  assert.equal(choice.mode, 'fit-width');
  choice = resizeResponsivePageChoiceV1(choice, 761);
  assert.equal(choice.mode, 'fit-page');
  choice = selectResponsivePageModeV1(choice, 'actual-size');
  assert.equal(resizeResponsivePageChoiceV1(choice, 320), choice);
});

test('route entry creates a fresh implicit choice instead of carrying another board selection', () => {
  const previous = selectResponsivePageModeV1(
    createResponsivePageChoiceV1('board-1', 1000),
    'actual-size',
  );
  const next = createResponsivePageChoiceV1('board-2', 320);
  assert.equal(previous.choiceKind, 'explicit');
  assert.deepEqual(next, {
    routeBoardId: 'board-2',
    choiceKind: 'implicit',
    mode: 'fit-width',
  });
});
