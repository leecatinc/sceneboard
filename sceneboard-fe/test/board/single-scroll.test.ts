import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = (relative: string) =>
  readFileSync(new URL(`../../${relative}`, import.meta.url), 'utf8');

test('PAGE is the sole normal-mode board vertical scroll owner', () => {
  const stage = source('components/board/PresentationStage.tsx');
  const stageStyles = source('components/board/PresentationStage.module.css');
  const boardStyles = source('app/boards/[boardId]/board.module.css');
  const route = source('app/boards/[boardId]/board-client.tsx');

  assert.match(stage, /data-page-scroll-owner="PAGE"/u);
  assert.match(stage, /tabIndex=\{0\}/u);
  assert.match(stageStyles, /\.stage\s*\{[^}]*overflow-x:\s*hidden;[^}]*overflow-y:\s*auto;/su);
  assert.match(boardStyles, /\.workspace\s*\{[^}]*overflow:\s*clip;/su);
  assert.match(boardStyles, /\.surface\s*\{[^}]*overflow:\s*clip;/su);
  assert.match(route, /<PresentationStage[\s\S]*?stageRef=\{bindPageStage\}/u);
});

test('board selectors are extracted without adding another global PAGE owner', () => {
  const globals = source('app/globals.css');
  const stageStyles = source('components/board/PresentationStage.module.css');

  assert.doesNotMatch(globals, /\.board-workspace\s*\{/u);
  assert.doesNotMatch(globals, /\.board-surface\s*\{/u);
  assert.doesNotMatch(globals, /\.scene-surface\s*\{/u);
  assert.doesNotMatch(globals, /\.scene-canvas-viewport\s*\{/u);
  assert.doesNotMatch(globals, /\.scene-root\s*>\s*\.scene-tabs\s*>\s*\.scene-tab-panel/u);
  assert.match(stageStyles, /:global\(\.scene-canvas-stage\)/u);
  assert.match(stageStyles, /:global\(\.artifact-frame-container\)/u);
});

test('nested presentation surfaces do not declare auto or scroll overflow', () => {
  const stageStyles = source('components/board/PresentationStage.module.css');
  const globals = source('app/globals.css');
  const presentationDeclarations = [
    'scene-canvas-stage',
    'scene-canvas-child',
    'scene-canvas-list',
    'scene-drawing-viewport',
    'scene-table-scroll',
    'artifact-frame-container',
  ];
  for (const name of presentationDeclarations) {
    const matchingGlobalBlocks =
      globals.match(new RegExp(`\\.${name}[^{}]*\\{[^}]*\\}`, 'gu')) ?? [];
    assert.equal(
      matchingGlobalBlocks.some((block) => /overflow(?:-[xy])?:\s*(?:auto|scroll)/u.test(block)),
      false,
      `${name} must not own presentation scrolling`,
    );
  }
  assert.doesNotMatch(
    stageStyles,
    /:global\(\.(?:scene|artifact)[^)]+\)[^{]*\{[^}]*overflow(?:-[xy])?:\s*(?:auto|scroll)/su,
  );
});
