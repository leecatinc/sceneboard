import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = (relative: string) =>
  readFileSync(new URL(`../../${relative}`, import.meta.url), 'utf8');

test('presentation targets the bound PAGE and never forwards artifact fullscreen', () => {
  const route = source('app/boards/[boardId]/board-client.tsx');
  const enter = route.slice(
    route.indexOf('const enterPresentation'),
    route.indexOf('const setCaptureActive'),
  );
  assert.match(enter, /const page = pageScrollRef\.current/u);
  assert.match(enter, /page\.requestFullscreen\(\)/u);
  assert.match(enter, /document\.fullscreenElement === page/u);
  assert.doesNotMatch(enter, /artifact|capability|share|replaceDocument|transformDocument/u);
  const artifactRenderer = route.slice(
    route.indexOf('const renderArtifact'),
    route.indexOf('const renderHitl'),
  );
  assert.doesNotMatch(artifactRenderer, /fullscreen|requestFullscreen/u);
});

test('route lifecycle uses exact epochs, stale guards, matching exit, and focus fallback', () => {
  const route = source('app/boards/[boardId]/board-client.tsx');
  assert.match(
    route,
    /boardId,\s*revisionId,\s*routeEpoch: `\$\{boardId\}:\$\{revisionId\}`,\s*pageElementEpoch: pageElementEpochRef\.current,\s*requestEpoch:/su,
  );
  assert.match(route, /presentationSettlementIsCurrentV1\(/u);
  assert.match(route, /document\.fullscreenElement !== page/u);
  assert.match(route, /presentationStateRef\.current\.mode === 'focus'/u);
  assert.match(route, /current\.mode === 'fullscreen'/u);
  assert.match(route, /invoker\?\.isConnected/u);
  assert.match(route, /page\?\.isConnected/u);
});

test('visibility component owns one timer, exact holds, first Tab, and bottom-edge activity', () => {
  const overlay = source('components/board/PresentationControlOverlay.tsx');
  assert.equal((overlay.match(/useRef<ReturnType<typeof setTimeout>/gu) ?? []).length, 1);
  for (const key of [
    'controlsFocusWithin',
    'dialogOrMenuOpen',
    'hitlInteractionActive',
    'artifactCaptureActive',
    'moveCaptureActive',
    'prefersReducedMotion',
  ])
    assert.match(overlay, new RegExp(`\\b${key}\\b`, 'u'));
  assert.match(overlay, /event\.key !== 'Tab'/u);
  assert.match(overlay, /firstControlRef\.current\?\.focus\(\)/u);
  assert.doesNotMatch(overlay, /window\.addEventListener\('pointermove', recordActivity/u);
  assert.match(overlay, /className=\{styles\.revealZone\}/u);
  assert.match(overlay, /onPointerEnter=\{recordActivity\}/u);
  assert.doesNotMatch(overlay, /presentation\.showControls/u);
  assert.match(overlay, /data-presentation-controls=\{visibility\.phase\}/u);
});
