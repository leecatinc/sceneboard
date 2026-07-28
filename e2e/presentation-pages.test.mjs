import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('presentation pages keep one PAGE scroll owner and close browser X overflow', () => {
  const stage = read('sceneboard-fe/components/board/PresentationStage.module.css');
  const stageComponent = read('sceneboard-fe/components/board/PresentationStage.tsx');
  const globals = read('sceneboard-fe/app/globals.css');
  const shared = read('sceneboard-fe/app/s/[shareToken]/shared-board-client.tsx');
  assert.match(stage, /\.stage \{[\s\S]*overflow-x: hidden;[\s\S]*overflow-y: auto;/u);
  assert.match(globals, /html \{[\s\S]*overflow-x: hidden;/u);
  assert.match(globals, /body \{[\s\S]*overflow-x: hidden;/u);
  assert.match(stageComponent, /data-page-scroll-owner="PAGE"/u);
  assert.match(shared, /stageRef\.current\.scrollTop = 0/u);
});

test('page navigation, revision dropdown, fullscreen fallback, and 320px move contracts stay executable', () => {
  const keys = read('sceneboard-fe/lib/board/page-navigation.ts');
  const history = read('sceneboard-fe/components/board/HistoryControls.tsx');
  const presentation = read('sceneboard-fe/lib/board/presentation-mode.controller.ts');
  const ownerClient = read('sceneboard-fe/app/boards/[boardId]/board-client.tsx');
  const move = read('sceneboard-fe/lib/board/page-move-mode.controller.ts');
  const responsive = read('sceneboard-fe/lib/board/responsive-page-mode.ts');
  assert.match(keys, /ArrowLeft/u);
  assert.match(keys, /ArrowRight/u);
  assert.match(keys, /Home/u);
  assert.match(keys, /End/u);
  assert.match(keys, /pageNavigationContextIsExcludedV1/u);
  assert.match(history, /historyLatestRevision/u);
  assert.match(history, /onSelectLatest/u);
  assert.match(history, /role="listbox"/u);
  assert.match(ownerClient, /requestFullscreen/u);
  assert.match(presentation, /fullscreen-entered/u);
  assert.match(presentation, /fallback-focus/u);
  assert.match(move, /classifyPageMoveIntentV1/u);
  assert.match(move, /clampPageMoveXV1/u);
  assert.match(responsive, /fit-width/u);
});
