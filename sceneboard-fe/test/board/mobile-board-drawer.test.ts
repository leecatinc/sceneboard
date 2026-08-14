import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  mobileBoardDrawerSlotSignatureV1,
  reduceMobileBoardDrawerV1,
} from '../../components/board/mobile-board-drawer-state';

const source = (relative: string) =>
  readFileSync(new URL(`../../${relative}`, import.meta.url), 'utf8');

test('slot hydration keeps the same open dialog epoch deterministically', () => {
  const empty = mobileBoardDrawerSlotSignatureV1([null, null, null]);
  const hydrated = mobileBoardDrawerSlotSignatureV1([null, 'history', 'connections']);
  const opened = reduceMobileBoardDrawerV1(
    { open: false, dialogEpoch: 0, slotSignature: empty },
    { type: 'open' },
  );
  const afterHydration = reduceMobileBoardDrawerV1(opened, {
    type: 'slots-hydrated',
    slotSignature: hydrated,
  });
  assert.equal(afterHydration.open, true);
  assert.equal(afterHydration.dialogEpoch, opened.dialogEpoch);
  assert.equal(afterHydration.slotSignature, hydrated);
});

test('mobile drawer exports the exact future-owned slot contract and one responsive mount owner', () => {
  const drawer = source('components/board/MobileBoardDrawer.tsx');
  const responsive = source('components/board/ResponsiveBoardChrome.tsx');
  const board = source('app/boards/[boardId]/board-client.tsx');
  for (const member of [
    'boardIdentity',
    'pageDisplay',
    'history',
    'status',
    'connections',
    'ownerAdmin',
  ])
    assert.match(drawer, new RegExp(`${member}: ReactNode \\| null`, 'u'));
  assert.match(responsive, /useSyncExternalStore\(/u);
  assert.match(responsive, /if \(mobile\)/u);
  assert.match(responsive, /<MobileBoardDrawer/u);
  assert.match(responsive, /<BoardTopBar/u);
  assert.equal((board.match(/const chromeSlots: MobileBoardDrawerSlotsV1 =/gu) ?? []).length, 1);
  assert.match(board, /<ResponsiveBoardChrome/u);
});

test('drawer owns modal focus, inert, body lock, route close, backdrop, and restore fallbacks', () => {
  const drawer = source('components/board/MobileBoardDrawer.tsx');
  const board = source('app/boards/[boardId]/board-client.tsx');
  assert.match(drawer, /role="dialog"/u);
  assert.match(drawer, /aria-modal="true"/u);
  assert.match(drawer, /background\.inert = true/u);
  assert.match(drawer, /document\.body\.style\.overflow = 'hidden'/u);
  assert.match(drawer, /event\.key === 'Escape'/u);
  assert.match(drawer, /event\.key !== 'Tab'/u);
  assert.match(drawer, /event\.target === event\.currentTarget/u);
  assert.match(drawer, /previousRouteRef\.current !== routeKey/u);
  assert.match(drawer, /openingTrigger\?\.isConnected/u);
  assert.match(drawer, /\[data-page-heading\]/u);
  assert.match(drawer, /dialogRef\.current\?\.contains\(document\.activeElement\)/u);
  assert.match(drawer, /closeRef\.current\?\.focus\(\)/u);
  assert.match(drawer, /const slotSignature = mobileBoardDrawerSlotSignatureV1\(\[/u);
  assert.match(drawer, /dispatchDrawer\(\{ type: 'slots-hydrated', slotSignature \}\)/u);
  assert.match(drawer, /data-mobile-drawer-dialog-epoch=\{drawerState\.dialogEpoch\}/u);
  assert.match(
    drawer,
    /useEffect\(\(\) => \{\s*if \(!open \|\| dialogRef\.current\?\.contains\(document\.activeElement\)\) return;\s*closeRef\.current\?\.focus\(\);\s*\}, \[drawerState\.slotSignature, open\]\)/u,
  );
  assert.match(
    board,
    /<ResponsiveBoardChrome[\s\S]*?routeKey=\{boardId\}[\s\S]*?presentationActive=/u,
  );
  assert.doesNotMatch(
    board,
    /routeKey=\{`\$\{boardId\}:\$\{visibleSnapshot\.revision\.revisionId\}`\}/u,
  );
});

test('viewport, bottom controls, safe area, and mutually exclusive scroll owners are explicit', () => {
  const layout = source('app/layout.tsx');
  const navigation = source('components/board/PageNavigationControls.tsx');
  const stageCss = source('components/board/PresentationStage.module.css');
  const drawerCss = source('components/board/MobileBoardDrawer.module.css');
  const globals = source('app/globals.css');
  assert.match(
    layout,
    /export const viewport: Viewport = \{\s*width: 'device-width',\s*initialScale: 1,\s*viewportFit: 'cover'/su,
  );
  assert.match(navigation, /data-page-bottom-navigation/u);
  assert.match(stageCss, /position: fixed/u);
  assert.match(stageCss, /max\(12px, env\(safe-area-inset-bottom\)\)/u);
  assert.match(globals, /\.page-navigation-button \{\s*width: 44px;\s*height: 44px;/su);
  assert.match(drawerCss, /overflow-y: auto/u);
  assert.match(globals, /mobile-board-drawer-open \[data-page-scroll-owner='PAGE'\]/u);
});

test('PAGE move plane registers exact passive policy, capture verification, and cleanup signals', () => {
  const stage = source('components/board/PresentationStage.tsx');
  const artifact = source('../packages/board-ui/src/artifact/ArtifactHost.tsx');
  const hitl = source('../packages/board-ui/src/interaction/HitlBlock.tsx');
  assert.match(stage, /pointerdown', pointerDown, \{ passive: true \}/u);
  assert.match(stage, /pointermove', pointerMove, \{ passive: false \}/u);
  assert.match(stage, /pointerup', pointerUp, \{ passive: true \}/u);
  assert.match(stage, /pointercancel', pointerCancel, \{ passive: true \}/u);
  assert.match(stage, /lostpointercapture', lostCapture, \{ passive: true \}/u);
  assert.match(stage, /plane\.setPointerCapture\(event\.pointerId\)/u);
  assert.match(stage, /plane\.hasPointerCapture\(event\.pointerId\)/u);
  assert.match(stage, /if \(event\.cancelable\) event\.preventDefault\(\)/u);
  assert.match(stage, /requestAnimationFrame\(applyLatestMove\)/u);
  assert.match(stage, /window\.addEventListener\('blur', cleanup\)/u);
  assert.match(stage, /document\.addEventListener\('visibilitychange', visibilityCleanup\)/u);
  assert.match(artifact, /data-artifact-capture/u);
  assert.match(hitl, /data-hitl-capture/u);
});

test('route, page, display, resize, and presentation transitions reset or reclamp Move explicitly', () => {
  const board = source('app/boards/[boardId]/board-client.tsx');
  const stage = source('components/board/PresentationStage.tsx');
  assert.match(board, /pageDisplaySelection\?\.routeBoardId === boardId/u);
  assert.match(board, /const selectPageDisplayMode[\s\S]*?setMoveToggle\(false\)/u);
  assert.match(board, /pageIdentityRef\.current = identity;\s*setMoveToggle\(false\)/u);
  assert.match(board, /setMoveAvailable\(false\);\s*setMoveToggle\(false\);/u);
  assert.match(stage, /finishGesture\('reset'\);\s*\}, \[finishGesture, moveIdentity\]\)/u);
  assert.match(stage, /finishGesture\('reclamp'\);\s*\}, \[finishGesture, presentationActive\]\)/u);
  assert.match(stage, /const observer = new ResizeObserver\(measure\)/u);
  assert.match(stage, /clampPageMoveXV1\(moveXRef\.current/u);
});
