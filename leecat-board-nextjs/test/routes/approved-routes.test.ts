import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

const workspace = resolve(import.meta.dirname, '../..');
const pages = [
  'app/(auth)/login/page.tsx',
  'app/(auth)/signup/page.tsx',
  'app/integrations/codex/page.tsx',
  'app/boards/page.tsx',
  'app/boards/[boardId]/page.tsx',
  'app/settings/ai-connections/page.tsx',
];

test('App Router exposes the approved SceneBoard product and public integration routes', () => {
  assert.equal(existsSync(resolve(workspace, 'app/page.tsx')), false);
  assert.equal(existsSync(resolve(workspace, 'app/settings/page.tsx')), false);
  for (const page of pages) assert.equal(existsSync(resolve(workspace, page)), true, page);
  const serverSources = pages.map((page) => readFileSync(resolve(workspace, page), 'utf8')).join('\n');
  assert.doesNotMatch(serverSources, /authSessionClient|BoardApiClient|localStorage|navigator\.locks|createBoardStreamClient/);
});

test('protected product clients are nested behind the single authenticated route boundary', () => {
  for (const page of ['app/boards/page.tsx', 'app/boards/[boardId]/page.tsx', 'app/settings/ai-connections/page.tsx']) {
    const source = readFileSync(resolve(workspace, page), 'utf8');
    assert.match(source, /<AuthenticatedRoute>/);
  }
});

test('account menu contains only account actions while AI connections links to public Codex onboarding', () => {
  const menu = readFileSync(resolve(workspace, 'components/app/UserMenu.tsx'), 'utf8');
  const modal = readFileSync(resolve(workspace, 'components/app/AccountModal.tsx'), 'utf8');
  const form = readFileSync(resolve(workspace, 'components/app/PasswordChangeForm.tsx'), 'utf8');
  const shell = readFileSync(resolve(workspace, 'components/app/AppShell.tsx'), 'utf8');
  const connections = readFileSync(resolve(workspace, 'app/settings/ai-connections/ai-connections-client.tsx'), 'utf8');
  const guide = readFileSync(resolve(workspace, 'app/settings/ai-connections/skill-install-guide.tsx'), 'utf8');
  const install = readFileSync(resolve(workspace, 'app/integrations/codex/codex-install-client.tsx'), 'utf8');
  assert.match(menu, /openDialog\('settings'\)/);
  assert.match(menu, /openDialog\('password'\)/);
  assert.match(menu, /<LanguageSelect[^>]+autoFocus \/>/);
  assert.match(menu, /<PasswordChangeForm \/>/);
  assert.doesNotMatch(menu, /downloads\/sceanboard|downloadSkill|skillDownload/);
  assert.match(connections, /<SkillInstallGuide \/>/);
  assert.match(guide, /href="\/integrations\/codex"/);
  assert.match(guide, /ai\.skillMcpPrerequisite/);
  assert.match(install, /codex plugin marketplace add leecatinc\/leecat-board-mcp/);
  assert.match(install, /codex plugin add sceneboard@sceneboard/);
  assert.match(install, /&lt;project&gt;\/\.mcp\.json/);
  assert.match(install, /https:\/\/sceneboard\.dev/);
  assert.equal(readFileSync(resolve(workspace, 'public/downloads/sceanboard.zip')).subarray(0, 4).toString('hex'), '504b0304');
  assert.equal(readFileSync(resolve(workspace, 'public/downloads/sceneboard-codex-plugin.zip')).subarray(0, 4).toString('hex'), '504b0304');
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

test('AI connection presentation preserves a bounded tab code and gates approval on the matching live code', () => {
  const owner = readFileSync(resolve(workspace, 'app/settings/ai-connections/ai-connections-client.tsx'), 'utf8');
  const pending = readFileSync(resolve(workspace, 'components/ai-connections/PairingRequestModal.tsx'), 'utf8');
  const requests = readFileSync(resolve(workspace, 'app/settings/ai-connections/pairing-request-list.tsx'), 'utf8');
  assert.match(owner, /document\.visibilityState !== 'visible'/);
  assert.match(owner, /window\.setInterval/);
  assert.match(owner, /created\?\.pairingId !== pairingId/);
  assert.match(owner, /readCreatedPairingSession\(window\.sessionStorage\)/);
  assert.match(owner, /writeCreatedPairingSession\(window\.sessionStorage/);
  assert.match(owner, /clearCreatedPairingSession\(window\.sessionStorage\)/);
  assert.match(owner, /newlyPending/);
  assert.match(owner, /createBoardForPairing/);
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
  assert.match(pending, /aria-multiselectable="true"/);
  assert.match(requests, /aria-haspopup="dialog"/);
  assert.match(requests, /requestRow/);
});

test('board top bar preserves live connection and history controls before pairing integration', () => {
  const topBar = readFileSync(resolve(workspace, 'components/board/BoardTopBar.tsx'), 'utf8');
  assert.match(topBar, /<ConnectionBanner connection=\{state\.connection\} \/>/);
  assert.match(topBar, /<HistoryControls/);
  assert.match(topBar, /onPrevious=\{onPrevious\}/);
  assert.match(topBar, /onNext=\{onNext\}/);
  assert.match(topBar, /onLatest=\{onLatest\}/);
});
