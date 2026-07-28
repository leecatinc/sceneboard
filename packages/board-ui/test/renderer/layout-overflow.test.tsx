import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(
  new URL('../../src/renderer/layouts/CanvasLayout.tsx', import.meta.url),
  'utf8',
);

test('CanvasLayout renders intrinsic geometry without local zoom or scroll control', () => {
  assert.doesNotMatch(source, /useState|setZoom|scene-canvas-controls|scene-canvas-viewport/u);
  assert.doesNotMatch(source, /onWheel|onPointer|onGesture|scale\(\$\{zoom\}\)/u);
  assert.match(source, /className="scene-canvas-stage"/u);
  assert.match(source, /className="scene-canvas-reserved"/u);
  assert.match(source, /'--scene-canvas-width': `\$\{node\.width\}px`/u);
  assert.match(source, /'--scene-canvas-height': `\$\{node\.height\}px`/u);
  assert.match(source, /<details className="scene-canvas-list">/u);
});
