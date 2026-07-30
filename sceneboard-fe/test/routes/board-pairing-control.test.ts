import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const root = new URL('../../', import.meta.url);
const source = (path: string) => readFileSync(new URL(path, root), 'utf8');

test('board owns an in-place pairing action without replacing live and history controls', () => {
  const boardClient = source('app/boards/[boardId]/board-client.tsx');
  const chromeSlots = source('components/board/BoardChromeSlots.tsx');
  assert.match(
    boardClient,
    /<BoardPairingControl[\s\S]*api=\{api\}[\s\S]*boardId=\{boardId\}[\s\S]*connectionGrantCeiling=/,
  );
  assert.match(chromeSlots, /pairingControl/);
  assert.match(chromeSlots, /<ConnectionBanner/);
  assert.match(chromeSlots, /<HistoryControls/);
  assert.doesNotMatch(boardClient, /window\.location|router\.push|settings\/ai-connections/);
  assert.match(
    source('components/board/BoardPairingControl.tsx'),
    /grant\.boardIds\.includes\(boardId\)/,
  );
});

test('board pairing keeps one bounded same-tab code and polls only in a visible single flight', () => {
  const control = source('components/board/BoardPairingControl.tsx');
  assert.match(control, /readCreatedPairingSession\(window\.sessionStorage\)/);
  assert.match(control, /writeCreatedPairingSession\(window\.sessionStorage/);
  assert.match(control, /document\.visibilityState !== 'visible' \|\| inFlight/);
  assert.match(control, /window\.setInterval\(\(\) => void refresh\(\), 2_000\)/);
  assert.match(control, /matching\?\.state === 'pending'.*setIsOpen\(true\)/s);
  assert.match(control, /onDismiss=\{\(\) => setIsOpen\(false\)\}/);
  assert.match(control, /aria-haspopup="dialog"\s+aria-expanded=\{isOpen\}/);
  assert.match(
    control,
    /api\.cancelPairing\(created\.pairingId, token, request\.controller\.signal\)/,
  );
  assert.match(
    control,
    /api\.rotateGrant\(boardGrant\.grantId, token, request\.controller\.signal\)/,
  );
  assert.match(
    control,
    /api\.revokeGrant\(boardGrant\.grantId, token, request\.controller\.signal\)/,
  );
});

test('board pairing approval prefers the current board and remains matching-code gated', () => {
  const control = source('components/board/BoardPairingControl.tsx');
  const modal = source('components/ai-connections/PairingRequestModal.tsx');
  assert.match(control, /api\.listBoards\(null, request\.controller\.signal\)/);
  assert.match(control, /preferredBoardId=\{boardId\}/);
  assert.match(modal, /useState<'create' \| 'existing'>\('existing'\)/);
  assert.match(modal, /setDestinationMode\('existing'\)/);
  assert.match(modal, /setSelectedBoardId\(availablePreferredBoardId\)/);
  assert.match(modal, /destination: PairingBoardDestination/);
  assert.match(modal, /matchingCode === null/);
  assert.match(modal, /approvedScopes\.includes\('board\.write'\)/);
  assert.match(modal, /connectionGrantCeiling\.scopes\.includes\(scope\)/);
  assert.match(modal, /connectionGrantCeiling\.lifecyclePermissions\.includes\(permission\)/);
  assert.match(modal, /approvedLifecyclePermissions\.includes\('board\.create'\)/);
  assert.match(modal, /destinationMode === 'create'.*!canCreateBoard/s);
  assert.match(modal, /t\('ai\.cancelCode'\)/);
  assert.match(modal, /onClick=\{onDismiss\}/);
  assert.match(modal, /onClick=\{onCancel\}/);
});

test('pairing requires an explicit choice before creating a new board', () => {
  const modal = source('components/ai-connections/PairingRequestModal.tsx');
  assert.doesNotMatch(modal, /setDestinationMode\(boardCreationRequested \? 'create'/);
  assert.match(modal, /value="create"[\s\S]*onChange=\{\(\) => setDestinationMode\('create'\)\}/);
  assert.match(modal, /destinationMode === 'create'.*!canCreateBoard/s);
});

test('header pairing carries the current detail board into the approval modal', () => {
  const header = source('components/app/HeaderPairingAction.tsx');
  assert.match(header, /usePathname\(\)/);
  assert.match(header, /boardIdFromDetailPath\(pathname \?\? ''\)/);
  assert.match(header, /preferredBoardId=\{preferredBoardId\}/);
});

test('AI connections redirects from the approved response board and falls back to the board list', () => {
  const client = source('app/settings/ai-connections/ai-connections-client.tsx');
  assert.match(client, /result\.value\.boardIds\?\.length === 1/);
  assert.match(client, /`\/boards\/\$\{encodeURIComponent\(result\.value\.boardIds\[0\]!\)\}`/);
  assert.match(client, /router\.replace\(destination\)/);
});
