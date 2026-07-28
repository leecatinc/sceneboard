import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');

test('image picker owns one-file image admission without intercepting the PAGE drag surface', () => {
  const control = source('components/board/BoardImageUploadControl.tsx');
  assert.match(control, /accept="image\/png,image\/jpeg,image\/webp"/u);
  assert.match(control, /items\.length !== 1 \|\| items\[0\]\?\.kind !== 'file'/u);
  assert.match(control, /if \(!ownsDrag\(event\)\) return;\s*event\.preventDefault\(\)/u);
  assert.doesNotMatch(control, /window\.addEventListener\(['"]drag/u);
  assert.doesNotMatch(control, /document\.addEventListener\(['"]drag/u);
});

test('media authoring has one responsive slot after page display and before history', () => {
  const drawer = source('components/board/MobileBoardDrawer.tsx');
  const chrome = source('components/board/ResponsiveBoardChrome.tsx');
  const topbar = source('components/board/BoardTopBar.tsx');
  const board = source('app/boards/[boardId]/board-client.tsx');
  assert.match(
    drawer,
    /\['pageDisplay', slots\.pageDisplay\],\s*\['mediaAuthoring', slots\.mediaAuthoring\],\s*\['history', slots\.history\]/u,
  );
  assert.equal((chrome.match(/mediaAuthoring=\{slots\.mediaAuthoring\}/gu) ?? []).length, 1);
  assert.equal((topbar.match(/board-topbar-media-authoring/gu) ?? []).length, 1);
  assert.equal((board.match(/<BoardImageUploadControl/gu) ?? []).length, 1);
  assert.match(board, /affordances\['media\.upload'\][\s\S]*state\.mode\.kind !== 'history'/u);
  assert.match(board, /'document' in session\.visibleSnapshot/u);
});

test('media authoring CSS remains bounded at 320px and owns no scroll surface', () => {
  const css = source('components/board/BoardImageUploadControl.module.css');
  assert.match(css, /max-width: 100%/u);
  assert.match(css, /min-width: 0/u);
  assert.doesNotMatch(css, /overflow(?:-x|-y)?:\s*(?:auto|scroll)/u);
});
