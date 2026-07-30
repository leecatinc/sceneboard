import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const styles = readFileSync(
  new URL('../../components/board/PresentationStage.module.css', import.meta.url),
  'utf8',
);

test('long code and markdown wrap into PAGE flow', () => {
  assert.match(
    styles,
    /:global\(\.scene-markdown pre\),[\s\S]*?:global\(\.scene-code pre\)\s*\{[^}]*overflow:\s*visible;[^}]*white-space:\s*pre-wrap;[^}]*overflow-wrap:\s*anywhere;/u,
  );
});

test('tables reflow without a horizontal scroll owner', () => {
  assert.match(styles, /:global\(\.scene-table-scroll table\)\s*\{[^}]*table-layout:\s*fixed;/su);
  assert.match(
    styles,
    /:global\(\.scene-table-scroll th\),[\s\S]*?:global\(\.scene-table-scroll td\)\s*\{[^}]*white-space:\s*normal;[^}]*overflow-wrap:\s*anywhere;/u,
  );
  assert.doesNotMatch(
    styles,
    /:global\(\.scene-table-scroll\)[^{]*\{[^}]*overflow-x:\s*(?:auto|scroll)/su,
  );
});

test('drawing, artifact, and readable canvas alternatives remain in PAGE flow', () => {
  assert.match(
    styles,
    /:global\(\.scene-drawing-viewport\),[\s\S]*?:global\(\.artifact-frame-container\)\s*\{[^}]*min-height:\s*18rem;[^}]*max-width:\s*100%;[^}]*overflow:\s*clip;/u,
  );
  assert.doesNotMatch(styles, /:global\(\.artifact-frame-container\)\s*\{[^}]*min-height:\s*0;/u);
  assert.match(styles, /:global\(\.scene-canvas-list\)\s*\{[^}]*border-top:[^}]*padding:/su);
});

test('artifact frame fills the measured stage height without the retired 55vh cap', () => {
  const globals = readFileSync(new URL('../../app/globals.css', import.meta.url), 'utf8');
  assert.match(
    globals,
    /\.artifact-frame-container\s*\{[^}]*height:\s*max\(18rem,\s*calc\(var\(--page-stage-viewport-height, 55vh\) - 2px\)\);[^}]*min-height:\s*18rem;/u,
  );
  assert.doesNotMatch(globals, /clamp\(18rem,\s*55vh,\s*52rem\)/u);
});

test('presentation stage propagates the measured viewport height to artifact descendants', () => {
  const stage = readFileSync(
    new URL('../../components/board/PresentationStage.tsx', import.meta.url),
    'utf8',
  );
  assert.match(stage, /'--page-stage-viewport-height':\s*`\$\{viewport\.height\}px`/u);
});
