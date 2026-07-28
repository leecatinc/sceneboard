import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

const workspace = resolve(import.meta.dirname, '../..');
const pages = [
  'app/page.tsx',
  'app/(auth)/login/page.tsx',
  'app/(auth)/signup/page.tsx',
  'app/integrations/codex/page.tsx',
  'app/boards/page.tsx',
  'app/boards/[boardId]/page.tsx',
  'app/settings/ai-connections/page.tsx',
];

test('App Router exposes the approved SceneBoard product and public integration routes', () => {
  assert.equal(existsSync(resolve(workspace, 'app/settings/page.tsx')), false);
  for (const page of pages) assert.equal(existsSync(resolve(workspace, page)), true, page);
  const serverSources = pages
    .map((page) => readFileSync(resolve(workspace, page), 'utf8'))
    .join('\n');
  assert.doesNotMatch(
    serverSources,
    /authSessionClient|BoardApiClient|localStorage|navigator\.locks|createBoardStreamClient/,
  );
});

test('protected product clients are nested behind the single authenticated route boundary', () => {
  for (const page of [
    'app/boards/page.tsx',
    'app/boards/[boardId]/page.tsx',
    'app/settings/ai-connections/page.tsx',
  ]) {
    const source = readFileSync(resolve(workspace, page), 'utf8');
    assert.match(source, /<AuthenticatedRoute>/);
  }
});

test('account menu contains only account actions while AI connections links to public Codex onboarding', () => {
  const menu = readFileSync(resolve(workspace, 'components/app/UserMenu.tsx'), 'utf8');
  const modal = readFileSync(resolve(workspace, 'components/app/AccountModal.tsx'), 'utf8');
  const form = readFileSync(resolve(workspace, 'components/app/PasswordChangeForm.tsx'), 'utf8');
  const shell = readFileSync(resolve(workspace, 'components/app/AppShell.tsx'), 'utf8');
  const connections = readFileSync(
    resolve(workspace, 'app/settings/ai-connections/ai-connections-client.tsx'),
    'utf8',
  );
  const guide = readFileSync(
    resolve(workspace, 'app/settings/ai-connections/skill-install-guide.tsx'),
    'utf8',
  );
  const install = readFileSync(
    resolve(workspace, 'app/integrations/codex/codex-install-client.tsx'),
    'utf8',
  );
  assert.match(menu, /openDialog\('settings'\)/);
  assert.match(menu, /openDialog\('password'\)/);
  assert.match(menu, /<LanguageSelect[^>]+autoFocus \/>/);
  assert.match(menu, /<PasswordChangeForm \/>/);
  assert.doesNotMatch(menu, /downloads\/sceneboard|downloadSkill|skillDownload/);
  assert.match(connections, /<SkillInstallGuide \/>/);
  assert.match(guide, /href="\/integrations\/codex"/);
  assert.match(guide, /ai\.skillMcpPrerequisite/);
  assert.match(install, /codex plugin marketplace add leecatinc\/sceneboard/);
  assert.doesNotMatch(install, /leecatinc\/sceneboard-mcp/);
  assert.match(install, /codex plugin add sceneboard@sceneboard/);
  assert.match(install, /&lt;project&gt;\/\.mcp\.json/);
  assert.match(install, /https:\/\/sceneboard\.dev/);
  assert.equal(
    readFileSync(resolve(workspace, 'public/downloads/sceneboard.zip'))
      .subarray(0, 4)
      .toString('hex'),
    '504b0304',
  );
  assert.equal(
    readFileSync(resolve(workspace, 'public/downloads/sceneboard-codex-plugin.zip'))
      .subarray(0, 4)
      .toString('hex'),
    '504b0304',
  );
  assert.doesNotMatch(menu, /user\.apiKeys|settings\/ai-connections/);
  assert.match(shell, /href="\/settings\/ai-connections"/);
  assert.match(modal, /<dialog/);
  assert.match(modal, /showModal\(\)/);
  assert.match(modal, /onCancel=/);
  assert.match(modal, /event\.target === event\.currentTarget/);
  assert.match(form, /name="currentPassword"/);
  assert.match(form, /name="newPassword"/);
  assert.match(form, /name="confirmPassword"/);
});

test('application header exposes one-shot code creation and keeps page scrolling below the header', () => {
  const shell = readFileSync(resolve(workspace, 'components/app/AppShell.tsx'), 'utf8');
  const action = readFileSync(resolve(workspace, 'components/app/HeaderPairingAction.tsx'), 'utf8');
  const lifecycle = readFileSync(
    resolve(workspace, 'components/app/BoardLifecycleNavigator.tsx'),
    'utf8',
  );
  const styles = readFileSync(resolve(workspace, 'app/globals.css'), 'utf8');
  assert.match(shell, /<HeaderPairingAction \/>/);
  assert.match(shell, /<BoardLifecycleNavigator \/>/);
  assert.match(lifecycle, /isBoardCreationAutoOpenPath\(currentPathname\)/);
  assert.match(lifecycle, /boardIdFromDetailPath\(currentPathname\)/);
  assert.match(lifecycle, /<ConfirmationDialog/);
  assert.match(lifecycle, /setPendingBoard\(createdBoard\)/);
  assert.match(lifecycle, /'board\.switchToNewBoard'/);
  assert.match(
    lifecycle,
    /router\.replace\(`\/boards\/\$\{encodeURIComponent\(createdBoard\.boardId\)\}`\)/,
  );
  assert.match(lifecycle, /router\.replace\('\/boards'\)/);
  assert.match(lifecycle, /document\.visibilityState !== 'visible'/);
  assert.match(action, /api\.createPairing\(token\)/);
  assert.match(action, /<PairingRequestModal/);
  assert.match(action, /api\.listActivePairings\(signal\)/);
  assert.match(action, /api\.listGrants\(null, signal\)/);
  assert.match(action, /'ai\.connected'/);
  assert.match(action, /'ai\.connecting'/);
  assert.match(action, /readCreatedPairingSession\(window\.sessionStorage\)/);
  assert.match(styles, /\.app-shell\s*\{[^}]*height:\s*100dvh;[^}]*overflow:\s*hidden;/);
  assert.match(styles, /\.app-main \{[^}]+min-height: 0;[^}]+overflow: auto;/);
  assert.match(
    styles,
    /\.app-shell-viewport-locked \.app-main \{[^}]+display: grid;[^}]+grid-template-rows: minmax\(0, 1fr\);[^}]+overflow: hidden;/,
  );
  assert.doesNotMatch(styles, /\.board-surface\s*\{/);
  assert.doesNotMatch(styles, /\.scene-surface\s*\{/);
  assert.doesNotMatch(styles, /\.scene-root > \.artifact-host,/);
  assert.doesNotMatch(styles, /\.scene-root > \.scene-drawing-block\s*\{/);
  assert.match(
    styles,
    /\.scene-drawing-viewport\[data-view-mode=['"]actual['"]\]\s*\{[^}]+overflow:\s*hidden;[^}]+cursor:\s*grab;/,
  );
  assert.match(
    styles,
    /\.scene-drawing-transform \.scene-drawing \{[^}]+width: 100%;[^}]+height: 100%;[^}]+max-height: none;/,
  );
});

test('AI connection presentation preserves a bounded tab code and gates approval on the matching live code', () => {
  const owner = readFileSync(
    resolve(workspace, 'app/settings/ai-connections/ai-connections-client.tsx'),
    'utf8',
  );
  const pending = readFileSync(
    resolve(workspace, 'components/ai-connections/PairingRequestModal.tsx'),
    'utf8',
  );
  const requests = readFileSync(
    resolve(workspace, 'app/settings/ai-connections/pairing-request-list.tsx'),
    'utf8',
  );
  assert.match(owner, /document\.visibilityState !== 'visible'/);
  assert.match(owner, /window\.setInterval/);
  assert.match(owner, /created\?\.pairingId !== pairingId/);
  assert.match(owner, /readCreatedPairingSession\(window\.sessionStorage\)/);
  assert.match(owner, /writeCreatedPairingSession\(window\.sessionStorage/);
  assert.match(owner, /clearCreatedPairingSession\(window\.sessionStorage\)/);
  assert.match(owner, /newlyPending/);
  assert.doesNotMatch(owner, /createBoardForPairing/);
  assert.match(owner, /location\.searchParams\.get\('create'\) === '1'/);
  assert.match(owner, /<PairingRequestList/);
  assert.match(owner, /<PairingRequestModal/);
  assert.match(pending, /matchingCode === null/);
  assert.match(pending, /t\('ai\.approve'\)/);
  assert.match(pending, /t\('ai\.cancelCode'\)/);
  assert.match(pending, /<footer className=\{styles\.actions\}>/);
  assert.match(pending, /form=\{formId\}/);
  assert.match(pending, /t\('ai\.selectScopeBoard'\)/);
  assert.match(pending, /<dialog/);
  assert.match(pending, /showModal\(\)/);
  assert.match(pending, /t\('boards\.new'\)/);
  assert.match(pending, /t\('ai\.searchBoards'\)/);
  assert.match(pending, /role="radiogroup"/);
  assert.match(pending, /destinationMode === 'create'/);
  assert.match(requests, /aria-haspopup="dialog"/);
  assert.match(requests, /requestRow/);
});

test('board top bar preserves live connection and history controls before pairing integration', () => {
  const topBar = readFileSync(resolve(workspace, 'components/board/BoardTopBar.tsx'), 'utf8');
  const chromeSlots = readFileSync(
    resolve(workspace, 'components/board/BoardChromeSlots.tsx'),
    'utf8',
  );
  const viewModes = readFileSync(
    resolve(workspace, 'components/board/BoardViewModeControls.tsx'),
    'utf8',
  );
  const statusRail = readFileSync(resolve(workspace, 'components/board/StatusRail.tsx'), 'utf8');
  const boardClient = readFileSync(
    resolve(workspace, 'app/boards/[boardId]/board-client.tsx'),
    'utf8',
  );
  assert.match(chromeSlots, /<ConnectionBanner connection=\{state\.connection\} \/>/);
  assert.match(chromeSlots, /<HistoryControls/);
  assert.match(chromeSlots, /onPrevious=\{onPrevious\}/);
  assert.match(chromeSlots, /onNext=\{onNext\}/);
  assert.match(chromeSlots, /onLatest=\{onLatest\}/);
  assert.match(
    chromeSlots,
    /<BoardViewModeControls\s+value=\{viewMode\}\s+zoom=\{artifactZoom\}\s+canReset=\{canResetArtifactView\}/,
  );
  assert.match(viewModes, /'fit-height', 'fit-width', 'actual'/);
  assert.match(viewModes, /aria-pressed=\{value === mode\}/);
  assert.match(viewModes, /board\.artifactZoomStatus/);
  assert.match(viewModes, /aria-live="polite"/);
  assert.match(viewModes, /board\.resetArtifactView/);
  assert.match(boardClient, /dispatchArtifactView\(\{ type: 'clear' \}\)/);
  assert.match(
    boardClient,
    /drawingView=\{\{[\s\S]*?mode:\s*artifactViewMode,[\s\S]*?resetSignal:\s*drawingResetSignal,[\s\S]*?onStateChange:\s*onDrawingViewStateChange,[\s\S]*?onCaptureActiveChange:/,
  );
  assert.match(
    boardClient,
    /rootIsDrawing \? drawingView\.scale : selectedArtifactZoomV1\(artifactViews\)/,
  );
  assert.match(boardClient, /setDrawingResetSignal\(\(value\) => value \+ 1\)/);
  assert.match(boardClient, /<BoardRenderer[\s\S]*?emptyLabel=""/);
  assert.match(boardClient, /return\s*\(\s*<BoardStatePanel\s+error=/);
  assert.match(viewModes, /onClick=\{onReset\}/);
  assert.match(chromeSlots, /artifactZoom/);
  assert.match(topBar, /board-topbar-history/);
  assert.match(statusRail, /artifact-stop-sidebar/);
  assert.match(statusRail, /onStopRendering/);
});
