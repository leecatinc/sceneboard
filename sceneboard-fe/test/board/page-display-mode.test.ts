import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  defaultPageDisplayModeV1,
  resolvePageDisplayModeV1,
} from '../../lib/board/page-display-mode.controller';
import {
  canvasPointToPageV1,
  canvasRectToPageV1,
  clientPointToPageV1,
  createPageCanvasTransformV1,
  pagePointToCanvasV1,
  pageRectToCanvasV1,
  visibleCanvasRectV1,
} from '../../lib/board/page-display-mode.types';

test('page display defaults are responsive only while selection is implicit', () => {
  assert.equal(defaultPageDisplayModeV1('desktop'), 'fit-page');
  assert.equal(defaultPageDisplayModeV1('mobile'), 'fit-width');
  assert.equal(
    resolvePageDisplayModeV1({
      routeBoardId: 'board-1',
      viewportClass: 'mobile',
      userSelection: 'actual-size',
    }),
    'actual-size',
  );
  assert.equal(
    resolvePageDisplayModeV1({
      routeBoardId: 'board-1',
      viewportClass: 'desktop',
      userSelection: 'fit-width',
    }),
    'fit-width',
  );
});

test('fit modes and actual-size use the exact scale, origin, reserve, and move contract', () => {
  assert.deepEqual(
    createPageCanvasTransformV1({
      mode: 'fit-page',
      viewportWidth: 500,
      viewportHeight: 500,
      canvasWidth: 1000,
      canvasHeight: 500,
    }),
    {
      mode: 'fit-page',
      scale: 0.5,
      originX: 0,
      originY: 0,
      moveX: 0,
      canvasWidth: 1000,
      canvasHeight: 500,
      reservedWidth: 500,
      reservedHeight: 250,
    },
  );
  assert.equal(
    createPageCanvasTransformV1({
      mode: 'fit-width',
      viewportWidth: 2000,
      viewportHeight: 500,
      canvasWidth: 1000,
      canvasHeight: 1000,
    })?.scale,
    2,
  );
  assert.deepEqual(
    createPageCanvasTransformV1({
      mode: 'actual-size',
      viewportWidth: 500,
      viewportHeight: 500,
      canvasWidth: 1000,
      canvasHeight: 500,
      moveX: -800,
    }),
    {
      mode: 'actual-size',
      scale: 1,
      originX: 0,
      originY: 0,
      moveX: -500,
      canvasWidth: 1000,
      canvasHeight: 500,
      reservedWidth: 1000,
      reservedHeight: 500,
    },
  );
  assert.equal(
    createPageCanvasTransformV1({
      mode: 'fit-page',
      viewportWidth: Number.NaN,
      viewportHeight: 10,
      canvasWidth: 10,
      canvasHeight: 10,
    }),
    null,
  );
  assert.equal(
    createPageCanvasTransformV1({
      mode: 'actual-size',
      viewportWidth: 500,
      viewportHeight: 500,
      canvasWidth: 1000,
      canvasHeight: 500,
      moveX: Number.NaN,
    })?.moveX,
    0,
  );
});

test('point and rectangle transforms round-trip within the authoring tolerance', () => {
  const transform = createPageCanvasTransformV1({
    mode: 'actual-size',
    viewportWidth: 640,
    viewportHeight: 480,
    canvasWidth: 1200,
    canvasHeight: 900,
    moveX: -321.25,
  });
  assert.ok(transform);
  const point = { x: 117.125, y: 233.75 };
  const rect = { x: 7.25, y: 8.5, width: 311.75, height: 179.125 };
  const roundTripPoint = pagePointToCanvasV1(transform, canvasPointToPageV1(transform, point));
  const roundTripRect = pageRectToCanvasV1(transform, canvasRectToPageV1(transform, rect));
  assert.ok(Math.abs(roundTripPoint.x - point.x) <= 1e-6);
  assert.ok(Math.abs(roundTripPoint.y - point.y) <= 1e-6);
  assert.ok(Math.abs(roundTripRect.x - rect.x) <= 1e-6);
  assert.ok(Math.abs(roundTripRect.y - rect.y) <= 1e-6);
  assert.ok(Math.abs(roundTripRect.width - rect.width) <= 1e-6);
  assert.ok(Math.abs(roundTripRect.height - rect.height) <= 1e-6);
});

test('client coordinates include PAGE scroll and visible bounds intersect the canvas', () => {
  const transform = createPageCanvasTransformV1({
    mode: 'actual-size',
    viewportWidth: 500,
    viewportHeight: 400,
    canvasWidth: 1000,
    canvasHeight: 900,
    moveX: -200,
  });
  assert.ok(transform);
  assert.deepEqual(clientPointToPageV1({ x: 150, y: 250 }, { x: 100, y: 200 }, 300), {
    x: 50,
    y: 350,
  });
  assert.deepEqual(
    visibleCanvasRectV1(transform, { x: 100, y: 200, width: 500, height: 400 }, 300),
    { x: 200, y: 300, width: 500, height: 400 },
  );
});

test('route state keeps page and artifact display controllers independent', () => {
  const route = readFileSync(
    new URL('../../app/boards/[boardId]/board-client.tsx', import.meta.url),
    'utf8',
  );
  assert.match(
    route,
    /pageDisplaySelection\?\.routeBoardId === boardId \? pageDisplaySelection\.mode : null/u,
  );
  assert.match(
    route,
    /const selectPageDisplayMode = \(mode: PageDisplayModeV1\) => \{\s*setPageDisplaySelection\(\{ routeBoardId: boardId, mode \}\);\s*setMoveToggle\(false\);/u,
  );
  assert.match(route, /viewMode=\{artifactViewMode\}/u);
  assert.doesNotMatch(route, /setArtifactViewMode\(pageDisplayMode\)/u);
  assert.doesNotMatch(route, /setPageDisplaySelection\(artifactViewMode\)/u);
});
