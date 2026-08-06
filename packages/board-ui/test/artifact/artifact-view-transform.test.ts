import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ARTIFACT_VIEW_MAX_SCALE,
  ARTIFACT_VIEW_MIN_SCALE,
  centerArtifactViewV1,
  fitArtifactViewV1,
  mapArtifactAnchorV1,
  panArtifactViewByInnerDeltaV1,
  panArtifactViewV1,
  resolveArtifactFitRenderScaleV1,
  sizeArtifactStageV1,
  zoomArtifactViewV1,
} from '../../src/artifact/artifact-view-transform.js';

test('centers the actual-size artifact at 100 percent', () => {
  assert.deepEqual(
    centerArtifactViewV1({
      availableWidth: 1600,
      availableHeight: 900,
      contentWidth: 1200,
      contentHeight: 675,
    }),
    { scale: 1, x: 200, y: 112.5 },
  );
});

test('fit-page contains the whole page while fit-width only fits the width axis', () => {
  // 16:9 콘텐츠가 16:9 뷰포트에 들어갈 때 fit-page는 양축 모두 채우며 자르지 않는다.
  assert.deepEqual(
    fitArtifactViewV1({
      mode: 'fit-page',
      availableWidth: 1_600,
      availableHeight: 900,
      contentWidth: 1_200,
      contentHeight: 675,
    }),
    { scale: 4 / 3, x: 0, y: 0 },
  );
  assert.deepEqual(
    fitArtifactViewV1({
      mode: 'fit-width',
      availableWidth: 600,
      availableHeight: 800,
      contentWidth: 1_200,
      contentHeight: 675,
    }),
    { scale: 0.5, x: 0, y: 231.25 },
  );
  // 높이가 제한인 뷰포트에서 fit-page는 세로에 맞추고 가로 여분을 중앙 정렬한다.
  // 같은 입력의 fit-width는 세로가 넘쳐 잘리므로 두 모드 결과가 달라야 한다.
  assert.deepEqual(
    fitArtifactViewV1({
      mode: 'fit-page',
      availableWidth: 1_200,
      availableHeight: 600,
      contentWidth: 1_200,
      contentHeight: 800,
    }),
    { scale: 0.75, x: 150, y: 0 },
  );
  assert.deepEqual(
    fitArtifactViewV1({
      mode: 'fit-width',
      availableWidth: 1_200,
      availableHeight: 600,
      contentWidth: 1_200,
      contentHeight: 800,
    }),
    { scale: 1, x: 0, y: 0 },
  );
});

test('fit-page contains a 1920x1080 slide in a matching-aspect viewport without cropping', () => {
  assert.deepEqual(
    fitArtifactViewV1({
      mode: 'fit-page',
      availableWidth: 1_280,
      availableHeight: 720,
      contentWidth: 1_920,
      contentHeight: 1_080,
    }),
    { scale: 2 / 3, x: 0, y: 0 },
  );
});

test('uses a Fold3-sized viewport for a responsive 1920px fixed canvas', () => {
  const visualScale = 344 / 1920;
  const renderScale = resolveArtifactFitRenderScaleV1({
    visualScale,
    responsiveFixedCanvas: true,
  });

  assert.deepEqual(renderScale, {
    viewportScale: visualScale,
    compositorScale: 1,
  });
  assert.equal(1920 * renderScale.viewportScale, 344);
});

test('keeps the transform-only fallback for generic, upscaled, and invalid fits', () => {
  assert.deepEqual(
    resolveArtifactFitRenderScaleV1({ visualScale: 0.25, responsiveFixedCanvas: false }),
    { viewportScale: 1, compositorScale: 0.25 },
  );
  assert.deepEqual(
    resolveArtifactFitRenderScaleV1({ visualScale: 1.5, responsiveFixedCanvas: true }),
    { viewportScale: 1, compositorScale: 1.5 },
  );
  assert.deepEqual(
    resolveArtifactFitRenderScaleV1({ visualScale: Number.NaN, responsiveFixedCanvas: true }),
    { viewportScale: 1, compositorScale: 1 },
  );
});

test('sizes the layout plane from rendered bounds without scrolling the fitted axis', () => {
  assert.deepEqual(
    sizeArtifactStageV1({
      mode: 'fit-page',
      availableWidth: 900,
      availableHeight: 600,
      contentWidth: 1200,
      contentHeight: 600,
      scale: 1,
    }),
    {
      width: 1200,
      height: 600,
    },
  );
  assert.deepEqual(
    sizeArtifactStageV1({
      mode: 'fit-width',
      availableWidth: 900,
      availableHeight: 800,
      contentWidth: 1200,
      contentHeight: 600,
      scale: 0.75,
    }),
    {
      width: 900,
      height: 800,
    },
  );
  assert.deepEqual(
    sizeArtifactStageV1({
      mode: 'actual',
      availableWidth: 900,
      availableHeight: 600,
      contentWidth: 1200,
      contentHeight: 675,
      scale: 2,
    }),
    {
      width: 900,
      height: 600,
    },
  );
});

test('keeps the artifact coordinate below the pointer stable while zooming', () => {
  const before = { scale: 1, x: 100, y: 50 };
  const pointer = { x: 700, y: 400 };
  const contentBefore = {
    x: (pointer.x - before.x) / before.scale,
    y: (pointer.y - before.y) / before.scale,
  };
  const after = zoomArtifactViewV1({
    transform: before,
    pointerX: pointer.x,
    pointerY: pointer.y,
    deltaY: -240,
  });

  assert.ok(after.scale > before.scale);
  assert.ok(Math.abs((pointer.x - after.x) / after.scale - contentBefore.x) < 1e-9);
  assert.ok(Math.abs((pointer.y - after.y) / after.scale - contentBefore.y) < 1e-9);
});

test('clamps wheel zoom to the supported scale range', () => {
  const base = { scale: 1, x: 0, y: 0 };
  assert.equal(
    zoomArtifactViewV1({ transform: base, pointerX: 0, pointerY: 0, deltaY: -100_000 }).scale,
    ARTIFACT_VIEW_MAX_SCALE,
  );
  assert.equal(
    zoomArtifactViewV1({ transform: base, pointerX: 0, pointerY: 0, deltaY: 100_000 }).scale,
    ARTIFACT_VIEW_MIN_SCALE,
  );
});

test('moves the artifact by the middle-button drag distance', () => {
  assert.deepEqual(panArtifactViewV1({ scale: 1.5, x: 20, y: -10 }, 45, 30), {
    scale: 1.5,
    x: 65,
    y: 20,
  });
});

test('converts inner pan deltas through the current scale', () => {
  assert.deepEqual(panArtifactViewByInnerDeltaV1({ scale: 2, x: 10, y: 20 }, 3.5, -4), {
    scale: 2,
    x: 17,
    y: 12,
  });
});

test('maps millionth anchors through live frame and container rectangles', () => {
  assert.deepEqual(
    mapArtifactAnchorV1({
      xMillionth: 250_000,
      yMillionth: 750_000,
      containerLeft: 100,
      containerTop: 50,
      frameLeft: 200,
      frameTop: 100,
      frameWidth: 800,
      frameHeight: 400,
    }),
    { x: 300, y: 350 },
  );
});

test('preserves the last transform for non-finite input', () => {
  const current = { scale: 1, x: 4, y: 5 };
  assert.equal(
    zoomArtifactViewV1({ transform: current, pointerX: 1, pointerY: 2, deltaY: Number.NaN }),
    current,
  );
  assert.equal(panArtifactViewV1(current, Number.POSITIVE_INFINITY, 2), current);
});
