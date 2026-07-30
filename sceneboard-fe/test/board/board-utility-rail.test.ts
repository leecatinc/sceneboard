import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { deriveUtilityRailBadgesV1 } from '../../lib/board/utility-rail-badges';

const source = (relative: string) =>
  readFileSync(new URL(`../../${relative}`, import.meta.url), 'utf8');

test('zero-valued counts produce no badge and positive counts produce their badge', () => {
  assert.deepEqual(
    deriveUtilityRailBadgesV1({ aiCount: 0, interactionCount: 0, artifactCount: 0 }),
    { ai: null, interactions: null, artifacts: null },
  );
  assert.deepEqual(
    deriveUtilityRailBadgesV1({ aiCount: 3, interactionCount: 1, artifactCount: 2 }),
    { ai: 3, interactions: 1, artifacts: 2 },
  );
  assert.deepEqual(
    deriveUtilityRailBadgesV1({ aiCount: 0, interactionCount: 5, artifactCount: 0 }),
    { ai: null, interactions: 5, artifacts: null },
  );
  assert.deepEqual(
    deriveUtilityRailBadgesV1({ aiCount: -1, interactionCount: 0, artifactCount: 0 }),
    { ai: null, interactions: null, artifacts: null },
  );
});

test('BoardUtilityRail renders an exclusive overlay flyout with full access semantics', () => {
  const rail = source('components/board/BoardUtilityRail.tsx');
  const css = source('components/board/BoardUtilityRail.module.css');
  assert.match(rail, /deriveUtilityRailBadgesV1/);
  assert.match(rail, /aria-expanded=\{isOpen\}/);
  assert.match(rail, /aria-controls=\{controlsId\}/);
  assert.match(rail, /aria-label=\{t\(panel\.labelKey\)\}/);
  assert.match(rail, /title=\{t\(panel\.labelKey\)\}/);
  assert.match(rail, /badge !== null &&/);
  assert.match(rail, /event\.key === 'Escape'/);
  assert.match(rail, /requestAnimationFrame\(\(\) => trigger\?\.focus\(\)\)/);
  assert.match(rail, /onStopRendering/);
  assert.match(rail, /presentationControl: ReactNode/u);
  assert.match(rail, /styles\.presentationAction/u);
  assert.match(rail, /board\.stopRendering/);
  assert.match(rail, /sharing\.close/);
  // The flyout enforces exclusivity through a single open-panel state.
  assert.match(rail, /useState<null \| RailPanel>\(null\)/);
  assert.match(css, /position: absolute/);
  assert.match(css, /right: 100%/);
  assert.match(css, /width: 52px/);
  assert.match(css, /width: 300px/);
});

test('BoardUtilityRail exposes an owner-only access-management panel', () => {
  const rail = source('components/board/BoardUtilityRail.tsx');
  // The access-management panel is added to the panel list only when owner-management controls are provided.
  assert.match(rail, /ownerAdmin\?: ReactNode/u);
  assert.match(rail, /ownerAdmin \? \[\.\.\.BASE_PANELS, ACCESS_PANEL\] : BASE_PANELS/u);
  assert.match(rail, /id: 'access', labelKey: 'presentation\.boardControls'/u);
  // The access-panel flyout exposes the owner-management controls (share/member and destructive management).
  assert.match(rail, /panel === 'access'/u);
  assert.match(rail, /styles\.management/u);
});
