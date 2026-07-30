import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = (relative: string) =>
  readFileSync(new URL(`../../${relative}`, import.meta.url), 'utf8');

test('desktop top bar owns page and revision navigation while presentation moves to the rail', () => {
  const topBar = source('components/board/BoardTopBar.tsx');
  const boardClient = source('app/boards/[boardId]/board-client.tsx');
  const rail = source('components/board/BoardUtilityRail.tsx');
  const identity = source('components/board/BoardChromeSlots.tsx');
  const presentation = source('components/board/PresentationModeControls.tsx');
  const globals = source('app/globals.css');

  assert.match(topBar, /board-topbar-page-navigation/u);
  assert.match(topBar, /board-topbar-revision/u);
  assert.doesNotMatch(topBar, /presentation/u);
  assert.match(identity, /compact\?: boolean/u);
  assert.match(identity, /if \(compact\)/u);
  assert.match(boardClient, /desktopBoardIdentity/u);
  assert.match(boardClient, /pageNavigation=\{pageNavigationControls\}/u);
  assert.match(boardClient, /revisionControls=\{desktopRevisionControls\}/u);
  assert.match(boardClient, /viewControls=\{sidebarViewControls\}/u);
  assert.match(boardClient, /presentationControl=\{presentationRailControl\}/u);
  assert.match(rail, /viewControls: ReactNode/u);
  assert.match(rail, /presentationControl: ReactNode/u);
  assert.match(rail, /t\('board\.viewMode'\)/u);
  assert.doesNotMatch(rail, /historyControls: ReactNode/u);
  assert.match(presentation, /variant\?: 'default' \| 'rail'/u);
  assert.match(presentation, /aria-label=\{label\}/u);
  assert.match(presentation, /title=\{label\}/u);
  assert.match(globals, /\.board-topbar \{[\s\S]*?height: 52px;/u);
  assert.match(globals, /\.board-stage-page-navigation \{\s*display: none;/u);
});

test('sidebar history is a newest-first direct selection list with an explicit latest action', () => {
  const history = source('components/board/HistoryControls.tsx');

  assert.match(history, /variant\?: 'combobox' \| 'sidebar'/u);
  assert.match(history, /variant === 'sidebar'/u);
  assert.match(history, /history-sidebar-latest/u);
  assert.match(history, /onSelectLatest/u);
  assert.match(history, /history\.rows\.filter/u);
  assert.match(history, /aria-pressed=\{selectedRevisionId === row\.revisionId\}/u);
});

test('the page pan control uses the agreed hand-tool wording and explanation', () => {
  const controls = source('components/board/PageMoveModeControls.tsx');
  const catalog = source('lib/i18n/catalogs/presentation.ts');

  assert.match(controls, /title=\{t\('presentation\.movePageDescription'\)\}/u);
  assert.match(catalog, /'presentation\.movePage',\n\s+'Pan tool',\n\s+'이동 도구'/u);
  assert.match(
    catalog,
    /'presentation\.movePageDescription',\n\s+'Drag to move the page view\.',\n\s+'화면을 드래그하여 이동합니다\.'/u,
  );
});
