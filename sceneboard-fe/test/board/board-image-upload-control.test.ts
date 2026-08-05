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
  assert.match(topbar, /mediaAuthoring !== null/u);
  assert.match(topbar, /aria-expanded=\{mediaOpen\}/u);
  assert.match(topbar, /hidden=\{!mediaOpen\}/u);
  assert.match(topbar, /mediaAuthoring\.ready/u);
  assert.equal((board.match(/<BoardImageUploadControl/gu) ?? []).length, 1);
  assert.match(board, /const MEDIA_AUTHORING_UI_ENABLED = false/u);
  assert.match(board, /MEDIA_AUTHORING_UI_ENABLED &&\s*affordances\['media\.upload'\]/u);
  assert.match(board, /affordances\['media\.upload'\][\s\S]*state\.mode\.kind !== 'history'/u);
  assert.match(board, /'document' in session\.visibleSnapshot/u);
});

test('the paused media entry point stays hidden and the AI connection action fits the top bar', () => {
  const globals = source('app/globals.css');
  assert.match(
    globals,
    /\.board-pairing-button\s*\{[\s\S]*height:\s*36px;[\s\S]*padding:\s*6px 12px;[\s\S]*line-height:\s*1;/u,
  );
});

test('desktop media authoring uses a fixed-height trigger and an out-of-flow popover', () => {
  const topbarCss = source('components/board/BoardTopBar.module.css');
  assert.match(topbarCss, /\.mediaTrigger[\s\S]*min-height:\s*36px/u);
  assert.match(topbarCss, /\.mediaPopover[\s\S]*position:\s*absolute/u);
  assert.match(topbarCss, /\.mediaPopover\[hidden\][\s\S]*display:\s*none/u);
  assert.match(topbarCss, /\.mediaPopoverBody[\s\S]*overflow-y:\s*auto/u);
});

test('media authoring CSS remains bounded at 320px and owns no scroll surface', () => {
  const css = source('components/board/BoardImageUploadControl.module.css');
  assert.match(css, /max-width: 100%/u);
  assert.match(css, /min-width: 0/u);
  assert.doesNotMatch(css, /overflow(?:-x|-y)?:\s*(?:auto|scroll)/u);
});
