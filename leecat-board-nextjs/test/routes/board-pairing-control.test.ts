import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const root = new URL('../../', import.meta.url);
const source = (path: string) => readFileSync(new URL(path, root), 'utf8');

test('board owns an in-place pairing action without replacing live and history controls', () => {
  const boardClient = source('app/boards/[boardId]/board-client.tsx');
  const topBar = source('components/board/BoardTopBar.tsx');
  assert.match(boardClient, /<BoardPairingControl api=\{api\} boardId=\{boardId\} boardTitle=\{session\.title\} \/>/);
  assert.match(topBar, /pairingControl/);
  assert.match(topBar, /<ConnectionBanner/);
  assert.match(topBar, /<HistoryControls/);
  assert.doesNotMatch(boardClient, /window\.location|router\.push|settings\/ai-connections/);
});

test('board pairing keeps one bounded same-tab code and polls only in a visible single flight', () => {
  const control = source('components/board/BoardPairingControl.tsx');
  assert.match(control, /readCreatedPairingSession\(window\.sessionStorage\)/);
  assert.match(control, /writeCreatedPairingSession\(window\.sessionStorage/);
  assert.match(control, /document\.visibilityState !== 'visible' \|\| inFlight/);
  assert.match(control, /window\.setInterval\(\(\) => void refresh\(\), 2_000\)/);
  assert.match(control, /matching\?\.state === 'pending'.*setIsOpen\(true\)/s);
  assert.match(control, /onDismiss=\{\(\) => setIsOpen\(false\)\}/);
  assert.match(control, /aria-haspopup="dialog" aria-expanded=\{isOpen\}/);
  assert.match(control, /api\.cancelPairing\(created\.pairingId, token\)/);
});

test('board pairing approval defaults to the current board and remains matching-code gated', () => {
  const control = source('components/board/BoardPairingControl.tsx');
  const modal = source('components/ai-connections/PairingRequestModal.tsx');
  assert.match(control, /initialBoardIds=\{\[boardId\]\}/);
  assert.match(control, /api\.listBoards\(\)/);
  assert.match(modal, /ownerStatus\?\.boardIds \?\? initialBoardIds/);
  assert.match(modal, /matchingCode === null/);
  assert.match(modal, /approvedScopes\.length === 0 \|\| boardIds\.length === 0/);
  assert.match(modal, /t\('ai\.cancelCode'\)/);
  assert.match(modal, /onClick=\{onDismiss\}/);
  assert.match(modal, /onClick=\{onCancel\}/);
});
