import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import * as React from 'react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  commitPresentationAnnotationSnapshotV1,
  commitPresentationAnnotationStrokeV1,
  createPresentationAnnotationHistoryV1,
  createPresentationAnnotationPageHistoryV1,
  erasePresentationAnnotationStrokesV1,
  normalizePresentationAnnotationPointV1,
  presentationAnnotationGestureDispositionV1,
  presentationAnnotationHistoryCommandV1,
  presentationAnnotationPageKeyV1,
  presentationAnnotationPathV1,
  redoPresentationAnnotationV1,
  undoPresentationAnnotationV1,
  type PresentationAnnotationStrokeV1,
} from '../../lib/board/presentation-annotation.controller';

test('artifact slide identity scopes annotations without changing the legacy outer-page key', () => {
  const outer = 'share\u0000revision\u0000page-1';
  assert.equal(presentationAnnotationPageKeyV1(outer, null), outer);
  const opening = presentationAnnotationPageKeyV1(outer, {
    hostInstanceId: 'node-deck',
    incarnationKey: 'board:node-deck:artifact:version',
    pageId: 'opening',
  });
  const evidence = presentationAnnotationPageKeyV1(outer, {
    hostInstanceId: 'node-deck',
    incarnationKey: 'board:node-deck:artifact:version',
    pageId: 'evidence',
  });
  assert.notEqual(opening, evidence);
  assert.equal(
    presentationAnnotationPageKeyV1(outer, {
      hostInstanceId: 'node-deck',
      incarnationKey: 'board:node-deck:artifact:version',
      pageId: 'opening',
    }),
    opening,
  );
});

test('tool changes commit the active visible annotation gesture', () => {
  assert.equal(presentationAnnotationGestureDispositionV1('tool-change'), 'commit');
  assert.equal(presentationAnnotationGestureDispositionV1('pointer-cancel'), 'discard');
  assert.equal(presentationAnnotationGestureDispositionV1('presentation-exit'), 'discard');
});

const stroke = (
  id: string,
  points: PresentationAnnotationStrokeV1['points'],
  color = '#e5484d',
  width = 4,
): PresentationAnnotationStrokeV1 => ({ id, points, color, width });

test('editable internal pages do not inherit delayed live-session strokes from another page', () => {
  const external = [
    stroke('remote-page-stroke', [
      { x: 0.1, y: 0.1 },
      { x: 0.9, y: 0.9 },
    ]),
  ];
  assert.deepEqual(
    createPresentationAnnotationPageHistoryV1({ readOnly: false, externalStrokes: external })
      .present,
    [],
  );
  assert.equal(
    createPresentationAnnotationPageHistoryV1({ readOnly: true, externalStrokes: external })
      .present,
    external,
  );
});

test('committed strokes produce visible SVG paths and undo or redo the exact gesture', () => {
  const first = stroke('first', [
    { x: 0.1, y: 0.2 },
    { x: 0.4, y: 0.5 },
  ]);
  const committed = commitPresentationAnnotationStrokeV1(
    createPresentationAnnotationHistoryV1(),
    first,
  );
  assert.equal(
    presentationAnnotationPathV1(committed.present[0]!.points, 1000, 500),
    'M 100 100 L 400 250',
  );
  assert.equal(committed.present[0]!.color, '#e5484d');
  assert.equal(committed.present[0]!.width, 4);

  const undone = undoPresentationAnnotationV1(committed);
  assert.deepEqual(undone.present, []);
  assert.equal(undone.future[0], committed.present);

  const redone = redoPresentationAnnotationV1(undone);
  assert.equal(redone.present, committed.present);
  assert.equal(redone.future.length, 0);
});

test('one eraser gesture removes every intersected stroke and one undo restores the batch', () => {
  const crossingA = stroke('a', [
    { x: 0.1, y: 0.5 },
    { x: 0.9, y: 0.5 },
  ]);
  const crossingB = stroke('b', [
    { x: 0.5, y: 0.1 },
    { x: 0.5, y: 0.9 },
  ]);
  const remote = stroke('remote', [
    { x: 0.05, y: 0.05 },
    { x: 0.1, y: 0.05 },
  ]);
  const initial = commitPresentationAnnotationSnapshotV1(createPresentationAnnotationHistoryV1(), [
    crossingA,
    crossingB,
    remote,
  ]);
  const erasedStrokes = erasePresentationAnnotationStrokesV1({
    strokes: initial.present,
    point: { x: 0.5, y: 0.5 },
    width: 1000,
    height: 500,
    threshold: 14,
  });
  assert.deepEqual(erasedStrokes, [remote]);

  const erased = commitPresentationAnnotationSnapshotV1(initial, erasedStrokes);
  assert.deepEqual(undoPresentationAnnotationV1(erased).present, [crossingA, crossingB, remote]);
});

test('a new gesture clears redo while normalization clamps page-relative coordinates', () => {
  const base = commitPresentationAnnotationStrokeV1(
    createPresentationAnnotationHistoryV1(),
    stroke('a', [{ x: 0.2, y: 0.2 }]),
  );
  const undone = undoPresentationAnnotationV1(base);
  const replacement = commitPresentationAnnotationStrokeV1(
    undone,
    stroke('b', [{ x: 0.8, y: 0.8 }]),
  );
  assert.equal(replacement.future.length, 0);
  assert.deepEqual(
    normalizePresentationAnnotationPointV1({ x: -20, y: 900, width: 800, height: 600 }),
    { x: 0, y: 1 },
  );
});

test('history shortcuts admit platform undo and redo but preserve editable native input', () => {
  const command = (
    overrides: Partial<Parameters<typeof presentationAnnotationHistoryCommandV1>[0]>,
  ) =>
    presentationAnnotationHistoryCommandV1({
      key: 'z',
      ctrlKey: true,
      metaKey: false,
      shiftKey: false,
      altKey: false,
      defaultPrevented: false,
      isComposing: false,
      editableContext: false,
      ...overrides,
    });
  assert.equal(command({}), 'undo');
  assert.equal(command({ shiftKey: true }), 'redo');
  assert.equal(command({ key: 'y' }), 'redo');
  assert.equal(command({ ctrlKey: false, metaKey: true }), 'undo');
  assert.equal(command({ editableContext: true }), null);
  assert.equal(command({ altKey: true }), null);
});

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
const { PresentationAnnotationLayer } = requireFromHere(
  '../../components/board/PresentationAnnotationLayer.tsx',
) as typeof import('../../components/board/PresentationAnnotationLayer');

test('active annotation surface renders one localized accessible toolbar with safe defaults', () => {
  const html = renderToStaticMarkup(
    createElement(I18nProvider, {
      initialLocale: 'ko',
      children: createElement(PresentationAnnotationLayer, {
        active: true,
        pageKey: 'page-1',
        width: 1280,
        height: 720,
      }),
    }),
  );
  assert.match(html, /role="toolbar"/u);
  assert.match(html, /aria-label="발표 주석 도구"/u);
  assert.match(html, /aria-pressed="true">포인터/u);
  assert.match(html, /data-tool="pointer"/u);
  assert.match(html, /disabled="">되돌리기/u);
  assert.match(html, /disabled="">다시 실행/u);
  assert.match(html, />초기화<\/button>/u);
});

test('annotation layer is a sibling before the Move plane and intercepts only drawing tools', () => {
  const stage = readFileSync(
    new URL('../../components/board/PresentationStage.tsx', import.meta.url),
    'utf8',
  );
  const component = readFileSync(
    new URL('../../components/board/PresentationAnnotationLayer.tsx', import.meta.url),
    'utf8',
  );
  const css = readFileSync(
    new URL('../../components/board/PresentationAnnotationLayer.module.css', import.meta.url),
    'utf8',
  );
  assert.match(
    stage,
    /<PresentationAnnotationLayer[\s\S]*?<div ref=\{contentRef\} className=\{styles\.content\} data-page-move-plane>/u,
  );
  assert.match(stage, /pageKey=\{annotationPageKey \?\? moveIdentity\}/u);
  assert.match(component, /onPointerCancel/u);
  assert.match(component, /onLostPointerCapture/u);
  assert.match(component, /event\.stopPropagation\(\)/u);
  assert.match(
    component,
    /finishGesture\(presentationAnnotationGestureDispositionV1\('tool-change'\) === 'commit'\)/u,
  );
  assert.match(
    component,
    /clearAllAnnotations[\s\S]*?historiesRef\.current\.clear\(\)[\s\S]*?createPresentationAnnotationHistoryV1\(\)[\s\S]*?showHistory\(next\)/u,
  );
  assert.match(component, /presentation\.annotationRedo[\s\S]*?presentation\.annotationClearAll/u);
  assert.match(
    component,
    /onVisibleStateChange\?\.\(\[\.\.\.historyRef\.current\.present, draftStroke\], 'transient'\)/u,
  );
  assert.match(
    component,
    /onVisibleStateChange\?\.\(history\.present, gestureRef\.current === null \? 'final' : 'transient'\)/u,
  );
  assert.match(css, /\.canvas\s*\{[^}]*pointer-events: none/su);
  assert.match(css, /\.canvas\[data-tool='pen'\],[\s\S]*pointer-events: auto/su);
  assert.match(css, /touch-action: none/u);
});

test('owner and public artifact hosts forward stable internal slide identity into annotation keys', () => {
  const owner = readFileSync(
    new URL('../../app/boards/[boardId]/board-client.tsx', import.meta.url),
    'utf8',
  );
  const publicClient = readFileSync(
    new URL('../../app/s/[shareToken]/shared-board-client.tsx', import.meta.url),
    'utf8',
  );
  const publicHost = readFileSync(
    new URL('../../app/s/[shareToken]/public-share-artifact-host.tsx', import.meta.url),
    'utf8',
  );
  for (const source of [owner, publicClient]) {
    assert.match(source, /presentationAnnotationPageKeyV1/u);
    assert.match(source, /onPresentationPageChange/u);
    assert.match(source, /outerPageKey: outerAnnotationPageKey/u);
  }
  assert.match(owner, /annotationPageKey=\{annotationPageKey\}/u);
  assert.match(publicClient, /annotationPageKey=\{annotationPageKey\}/u);
  assert.match(publicHost, /onPresentationPageChange === undefined/u);
});
