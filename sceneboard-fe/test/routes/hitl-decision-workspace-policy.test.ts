import assert from 'node:assert/strict';
import test from 'node:test';
import type { HitlInteractionV1 } from '@sceneboard/board-schema';

import { shouldPreferExpandedDecisionWorkspaceV1 } from '../../lib/board/hitl-decision-workspace-policy';

const interaction = (definition: HitlInteractionV1['definition']): HitlInteractionV1 =>
  ({ definition }) as HitlInteractionV1;

test('prefers expanded HITL workspace for long context and dense decision controls', () => {
  assert.equal(
    shouldPreferExpandedDecisionWorkspaceV1([
      interaction({
        kind: 'info',
        title: 'Release context',
        body: 'x'.repeat(1_201),
        acknowledgeLabel: 'Understood',
      }),
    ]),
    true,
  );
  assert.equal(
    shouldPreferExpandedDecisionWorkspaceV1([
      interaction({
        kind: 'choice',
        title: 'Review priority',
        multiple: false,
        minSelections: 1,
        maxSelections: 1,
        options: Array.from({ length: 7 }, (_, index) => ({
          id: `option_${index}` as never,
          label: `Option ${index}`,
        })),
      }),
    ]),
    true,
  );
  assert.equal(
    shouldPreferExpandedDecisionWorkspaceV1([
      interaction({
        kind: 'confirmation',
        title: 'Continue?',
        body: 'The change is limited to this visual review.',
        impact: 'standard',
        confirmLabel: 'Continue',
        cancelLabel: 'Keep current state',
      }),
    ]),
    false,
  );
});
