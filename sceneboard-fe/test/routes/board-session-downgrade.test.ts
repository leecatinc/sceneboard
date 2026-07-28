import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import type { BoardSessionAccessV1 } from '@sceneboard/board-schema';

import {
  deriveBoardAffordancesV1,
  EMPTY_BOARD_SESSION_ACCESS_V1,
  lostBoardUiOperationsV1,
} from '../../lib/board/board-capabilities';

const source = (path: string): string =>
  readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');

const owner: BoardSessionAccessV1 = {
  ...EMPTY_BOARD_SESSION_ACCESS_V1,
  capabilityEpoch: 2,
  authorizationCapabilities: [
    'board.admin',
    'board.analytics.read',
    'board.history.read',
    'board.members.manage',
    'board.read',
    'board.share.manage',
    'board.write',
    'connection.manage.own',
  ],
};

test('owner downgrade detects every newly forbidden surface before slot replacement', () => {
  const lost = lostBoardUiOperationsV1(
    deriveBoardAffordancesV1(owner),
    deriveBoardAffordancesV1({
      ...EMPTY_BOARD_SESSION_ACCESS_V1,
      capabilityEpoch: 3,
      authorizationCapabilities: ['board.read'],
    }),
  );
  assert.deepEqual(lost, [
    'history.read',
    'board.write',
    'scene.restore',
    'connection.create',
    'connection.update',
    'connection.revoke',
    'membership.manage',
    'share.manage',
    'analytics.read',
    'board.archive',
    'board.delete',
  ]);
});

test('BoardClient closes and clears owner state before committing the filtered slot set', () => {
  const client = source('app/boards/[boardId]/board-client.tsx');
  const closeIndex = client.indexOf('ownerAdminRef.current?.closeAndClearOwnerAdmin()');
  const slotIndex = client.indexOf('setRenderedAccess({ boardId, access: nextAccess })');
  assert.notEqual(closeIndex, -1);
  assert.notEqual(slotIndex, -1);
  assert.ok(closeIndex < slotIndex);
  assert.match(client, /closeHistory\(\);\s+void loadLatestSnapshot\(true\)/u);
  assert.match(client, /mobile-board-drawer-trigger/u);
  assert.match(client, /data-page-heading/u);
  assert.match(client, /board\.capabilitiesChanged/u);
});

test('owner, pairing, and one-time credential paths expose synchronous invalidation handoffs', () => {
  const ownerControls = source('components/board/OwnerAdminControls.tsx');
  const pairing = source('components/board/BoardPairingControl.tsx');
  const share = source('components/board/ShareManagementSheet.tsx');
  assert.match(ownerControls, /closeAndClearOwnerAdmin\(\)/u);
  assert.match(ownerControls, /setForcedCloseEpoch\(\(current\) => current \+ 1\)/u);
  assert.match(pairing, /for \(const controller of requestAborts\.current\.values\(\)\)/u);
  assert.match(pairing, /clearCreatedPairingSession\(window\.sessionStorage\)/u);
  assert.match(pairing, /setRotatedCredential\(null\)/u);
  assert.match(share, /requestAbortRef\.current\?\.abort\(\)/u);
  assert.match(share, /invalidateSecret\(\)/u);
});
