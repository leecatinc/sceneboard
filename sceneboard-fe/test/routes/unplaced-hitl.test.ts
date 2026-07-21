import assert from 'node:assert/strict';
import test from 'node:test';

import { selectUnplacedOpenHitlV1 } from '../../lib/board/unplaced-hitl';

const interaction = (hitlRequestId: string, state: 'open' | 'answered') => ({
  hitlRequestId,
  definition: { kind: 'info', title: 'Information', body: 'Read this.', acknowledgeLabel: 'OK' },
  state,
  createdAt: '2026-07-20T00:00:00.000Z',
  expiresAt: '2026-07-20T00:15:00.000Z',
  stateUpdatedAt: '2026-07-20T00:00:00.000Z',
  response: state === 'answered' ? { kind: 'info', acknowledged: true } : null,
  answeredAt: state === 'answered' ? '2026-07-20T00:01:00.000Z' : null,
});

test('selects only open HITL interactions that have no explicit scene node', () => {
  const snapshot = {
    scene: {
      root: {
        id: 'root',
        type: 'layout.split',
        direction: 'vertical',
        gap: 12,
        children: [
          { weight: 1, node: { id: 'prompt', type: 'content.hitl', hitlRequestId: 'hitl_placed' } },
          { weight: 1, node: { id: 'copy', type: 'content.markdown', markdown: 'Demo' } },
        ],
      },
    },
    hitl: [
      interaction('hitl_placed', 'open'),
      interaction('hitl_unplaced', 'open'),
      interaction('hitl_answered', 'answered'),
    ],
  } as never;
  assert.deepEqual(
    selectUnplacedOpenHitlV1(snapshot).map((item) => item.hitlRequestId),
    ['hitl_unplaced'],
  );
});
