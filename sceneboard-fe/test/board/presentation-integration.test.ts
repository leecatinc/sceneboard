import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import * as React from 'react';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  firstEnabledPresentationControlV1,
  focusPresentationControlV1,
  type PresentationControlFocusCandidateV1,
} from '../../lib/board/presentation-control-visibility';

const requireFromHere = createRequire(import.meta.url);
(globalThis as typeof globalThis & { React: typeof React }).React = React;
requireFromHere.extensions['.css'] = (module) => {
  module.exports = {
    __esModule: true,
    default: new Proxy({}, { get: (_, key) => String(key) }),
  };
};
const { I18nProvider } = requireFromHere(
  '../../components/i18n/I18nProvider.tsx',
) as typeof import('../../components/i18n/I18nProvider');
const { PresentationControlOverlay } = requireFromHere(
  '../../components/board/PresentationControlOverlay.tsx',
) as typeof import('../../components/board/PresentationControlOverlay');
const { PageDisplayModeControls } = requireFromHere(
  '../../components/board/PageDisplayModeControls.tsx',
) as typeof import('../../components/board/PageDisplayModeControls');
const { BoardViewModeControls } = requireFromHere(
  '../../components/board/BoardViewModeControls.tsx',
) as typeof import('../../components/board/BoardViewModeControls');

const source = (relative: string) =>
  readFileSync(new URL(`../../${relative}`, import.meta.url), 'utf8');

const renderPresentationOverlay = (additionalControls: ReactNode) =>
  renderToStaticMarkup(
    createElement(I18nProvider, {
      initialLocale: 'en',
      children: createElement(PresentationControlOverlay, {
        active: true,
        activitySignal: 0,
        current: 1,
        total: 1,
        dialogOrMenuOpen: false,
        hitlInteractionActive: false,
        artifactCaptureActive: false,
        moveCaptureActive: false,
        additionalControls,
        onPrevious: () => undefined,
        onNext: () => undefined,
        onExit: () => undefined,
      }),
    }),
  );

test('presentation targets the board surface so its top bar remains in fullscreen', () => {
  const route = source('app/boards/[boardId]/board-client.tsx');
  const boardStyles = source('app/boards/[boardId]/board.module.css');
  const stage = source('components/board/PresentationStage.tsx');
  const enter = route.slice(
    route.indexOf('const enterPresentation'),
    route.indexOf('const setCaptureActive'),
  );
  assert.match(enter, /const page = presentationSurfaceRef\.current/u);
  assert.match(enter, /page\.requestFullscreen\(\)/u);
  assert.match(enter, /document\.fullscreenElement === page/u);
  assert.doesNotMatch(enter, /artifact|capability|share|replaceDocument|transformDocument/u);
  const artifactRenderer = route.slice(
    route.indexOf('const renderArtifact'),
    route.indexOf('const renderHitl'),
  );
  assert.doesNotMatch(artifactRenderer, /fullscreen|requestFullscreen/u);
  assert.match(route, /ref=\{bindPresentationSurface\}/u);
  assert.match(route, /presentationTopBar=\{presentationTopBar\}/u);
  assert.match(route, /overlay=\{null\}/u);
  assert.doesNotMatch(route, /<PresentationControlOverlay/u);
  assert.match(route, /annotationToolbarTarget=\{annotationToolbarTarget\}/u);
  assert.match(
    route,
    /const presentationTopBar = \([\s\S]*?<Brand[\s\S]*?board-topbar-title[\s\S]*?annotationToolbarSlot[\s\S]*?\{pageNavigationControls\}[\s\S]*?\{presentationControls\}/u,
  );
  assert.match(boardStyles, /\.presenting:fullscreen\s*\{[^}]*height:\s*100dvh;[^}]*\}/u);
  assert.match(stage, /const showToolbar = toolbar !== null && !presentationActive;/u);
  assert.match(stage, /data-has-toolbar=\{showToolbar\}/u);
  assert.match(stage, /\{showToolbar && \(/u);
});

test('owner presentation controls open the shared live-session chooser before fullscreen', () => {
  const route = source('app/boards/[boardId]/board-client.tsx');
  const controls = route.slice(
    route.indexOf('const presentationControls'),
    route.indexOf('const pageNavigationControls'),
  );
  assert.match(route, /import \{ PublicPresentationSessionDialog \}/u);
  assert.equal((controls.match(/setSessionDialogOpen\(true\)/gu) ?? []).length, 2);
  assert.equal((controls.match(/refreshPresentationSessions\(\)/gu) ?? []).length, 2);
  assert.doesNotMatch(controls, /onEnter=\{enterPresentation\}/u);
  assert.match(
    route,
    /<PublicPresentationSessionDialog[\s\S]*?onStart=\{\(\) => void startLivePresentation\(\)\}[\s\S]*?onJoin=\{\(sessionId\) => void joinLivePresentation\(sessionId\)\}/u,
  );
});

test('owner presentation entry is hidden when share management capability is absent', () => {
  const route = source('app/boards/[boardId]/board-client.tsx');

  assert.match(route, /const canUseOwnerPresentation = affordances\['share\.manage'\];/u);
  assert.match(
    route,
    /const canAdmitOwnerPresentation =[\s\S]*?deriveBoardAffordancesV1\(latestSessionAccess\)\['share\.manage'\];/u,
  );
  assert.match(
    route,
    /presentationSessionAdmissionRef\.current = \{[\s\S]*?allowed: canAdmitOwnerPresentation,/u,
  );
  assert.match(route, /const presentationControls = canUseOwnerPresentation \?/u);
  assert.match(route, /const presentationRailControl = canUseOwnerPresentation \?/u);
  assert.match(
    route,
    /if \(lost\.includes\('share\.manage'\)\) \{[\s\S]*?setSessionDialogOpen\(false\);[\s\S]*?exitPresentationRef\.current\(false\);/u,
  );
  assert.match(route, /presentationSessionOperationEpochRef\.current \+= 1;/u);
  assert.match(route, /ownerPresentationOperationIsCurrentV1\(/u);
  assert.match(
    route,
    /useEffect\(\(\) => \{[\s\S]*?presentationSessionAdmissionRef\.current = \{[\s\S]*?mounted: true,[\s\S]*?return \(\) => \{[\s\S]*?mounted: false,[\s\S]*?presentationSessionOperationEpochRef\.current \+= 1;/u,
  );
  assert.match(
    route,
    /if \(!isCurrent\(\)\) \{[\s\S]*?snapshot\.role === 'presenter'[\s\S]*?ownerPresentationApi[\s\S]*?\.end\(/u,
  );
  assert.match(
    route,
    /const joinLivePresentation[\s\S]*?const isCurrent = \(\) =>[\s\S]*?if \(isCurrent\(\)\) activateLivePresentation\(snapshot\);/u,
  );
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

test('visibility component owns one timer, exact holds, semantic first Tab, and bottom-edge activity', () => {
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
  assert.match(overlay, /firstEnabledPresentationControlV1/u);
  assert.match(overlay, /focusPresentationControlV1/u);
  assert.match(
    overlay,
    /\[previousControlRef\.current, nextControlRef\.current, exitControlRef\.current\]/u,
  );
  assert.match(overlay, /\{additionalControls\}[\s\S]*?<button ref=\{exitControlRef\}/u);
  assert.doesNotMatch(overlay, /window\.addEventListener\('pointermove', recordActivity/u);
  assert.match(overlay, /className=\{styles\.revealZone\}/u);
  assert.match(overlay, /onPointerEnter=\{recordActivity\}/u);
  assert.doesNotMatch(overlay, /presentation\.showControls/u);
  assert.match(overlay, /data-presentation-controls=\{visibility\.phase\}/u);
});

const focusCandidates = (states: readonly boolean[]) => {
  const focused: number[] = [];
  const candidates = states.map<PresentationControlFocusCandidateV1>((disabled, index) => ({
    disabled,
    isConnected: true,
    focus: () => focused.push(index),
  }));
  return { candidates, focused };
};

const selectSemanticFirstTabTarget = (candidates: readonly PresentationControlFocusCandidateV1[]) =>
  firstEnabledPresentationControlV1([candidates[0]!, candidates[1]!, candidates.at(-1)!]);

test('first Tab on page 1 focuses Next when Previous is disabled', () => {
  const { candidates, focused } = focusCandidates([true, false, false]);
  const target = selectSemanticFirstTabTarget(candidates);
  assert.equal(target, candidates[1]);
  assert.equal(focusPresentationControlV1(target), true);
  assert.deepEqual(focused, [1]);
});

test('one-page root-canvas controls fall back to Exit after enabled display controls', () => {
  const html = renderPresentationOverlay(
    createElement(PageDisplayModeControls, {
      value: 'fit-page',
      onChange: () => undefined,
    }),
  );
  assert.ok(html.indexOf('Fit page') < html.indexOf('Exit presentation'));
  const { candidates, focused } = focusCandidates([true, true, false, false, false, false]);
  const target = selectSemanticFirstTabTarget(candidates);
  assert.equal(target, candidates[5]);
  assert.equal(focusPresentationControlV1(target), true);
  assert.deepEqual(focused, [5]);
});

test('one-page artifact controls fall back to Exit after enabled view-mode controls', () => {
  const html = renderPresentationOverlay(
    createElement(BoardViewModeControls, {
      value: 'fit-page',
      zoom: 1,
      canReset: true,
      onChange: () => undefined,
      onReset: () => undefined,
    }),
  );
  assert.ok(html.indexOf('Fit page') < html.indexOf('Exit presentation'));
  const { candidates, focused } = focusCandidates([true, true, false, false, false, true, false]);
  const target = selectSemanticFirstTabTarget(candidates);
  assert.equal(target, candidates[6]);
  assert.equal(focusPresentationControlV1(target), true);
  assert.deepEqual(focused, [6]);
});

test('first Tab focuses Previous on later pages and refuses a stale target', () => {
  const { candidates, focused } = focusCandidates([false, false, false]);
  const target = selectSemanticFirstTabTarget(candidates);
  assert.equal(target, candidates[0]);
  assert.ok(target);
  const staleTarget: PresentationControlFocusCandidateV1 = {
    ...target,
    isConnected: false,
  };
  assert.equal(focusPresentationControlV1(staleTarget), false);
  assert.deepEqual(focused, []);
});

test('deferred first Tab focus refuses a target disabled before the animation frame', () => {
  const focused: string[] = [];
  const target: PresentationControlFocusCandidateV1 = {
    disabled: false,
    isConnected: true,
    focus: () => focused.push('previous'),
  };
  assert.equal(firstEnabledPresentationControlV1([target]), target);
  Object.assign(target, { disabled: true });
  assert.equal(focusPresentationControlV1(target), false);
  assert.deepEqual(focused, []);
});
