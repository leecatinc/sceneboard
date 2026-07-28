import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (relative) => readFileSync(new URL(`../${relative}`, import.meta.url), 'utf8');

test('mobile reader keeps document X closed and switches PAGE/drawer vertical ownership', () => {
  const globals = read('sceneboard-fe/app/globals.css');
  const stage = read('sceneboard-fe/components/board/PresentationStage.module.css');
  const drawer = read('sceneboard-fe/components/board/MobileBoardDrawer.module.css');
  assert.match(globals, /html \{[\s\S]*?overflow-x: hidden;/);
  assert.match(globals, /body \{[\s\S]*?overflow-x: hidden;/);
  assert.match(stage, /\.stage \{[\s\S]*?overflow-x: hidden;[\s\S]*?overflow-y: auto;/);
  assert.match(drawer, /\.body \{[\s\S]*?overflow-x: hidden;[\s\S]*?overflow-y: auto;/);
  assert.match(globals, /mobile-board-drawer-open \[data-page-scroll-owner='PAGE'\]/);
});

test('mobile reader reserves measured bottom navigation plus the safe-area inset', () => {
  const stage = read('sceneboard-fe/components/board/PresentationStage.tsx');
  const css = read('sceneboard-fe/components/board/PresentationStage.module.css');
  assert.match(stage, /getBoundingClientRect\(\)\.height/);
  assert.match(stage, /--mobile-page-controls-height/);
  assert.match(
    css,
    /var\(--mobile-page-controls-height, 0px\) \+ max\(12px, env\(safe-area-inset-bottom\)\)/,
  );
});
