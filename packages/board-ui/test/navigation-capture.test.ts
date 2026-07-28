import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

test('artifact host closes capture on bridge, pointer, lost-capture, cancel, and unmount paths', () => {
  const artifact = source('../src/artifact/ArtifactHost.tsx');
  assert.match(artifact, /setCaptureSource\('bridge-pan', true\)/u);
  assert.match(artifact, /setCaptureSource\('bridge-pan', false\)/u);
  assert.match(artifact, /onPointerDown=/u);
  assert.match(artifact, /onPointerUp=/u);
  assert.match(artifact, /onPointerCancel=/u);
  assert.match(artifact, /onLostPointerCapture=/u);
  assert.match(artifact, /useEffect\(\(\) => \(\) => resetCanvasState\(\)/u);
});

test('drawing capture reports start, ordinary release, cancel, lost capture, and unmount', () => {
  const drawing = source('../src/renderer/blocks/DrawingBlock.tsx');
  assert.match(drawing, /onCaptureActiveChange\?\.\(true\)/u);
  assert.match(drawing, /onCaptureActiveChange\?\.\(false\)/u);
  assert.match(drawing, /onPointerUp=/u);
  assert.match(drawing, /onPointerCancel=\{stopPanning\}/u);
  assert.match(drawing, /onLostPointerCapture=\{stopPanning\}/u);
  assert.match(
    drawing,
    /useEffect\(\(\) => \(\) => latestControllerRef\.current\.onCaptureActiveChange\?\.\(false\)/u,
  );
});
