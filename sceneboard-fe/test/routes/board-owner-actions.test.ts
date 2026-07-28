import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import type { GrantSummary } from '../../lib/api/board-api';
import {
  hasVisibleGrantForBoard,
  visibleApprovedGrants,
} from '../../lib/ai-connections/visible-approved-grants';

const source = (path: string): string =>
  readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');

const grant = (status: GrantSummary['status']): GrantSummary => ({
  grantId: `grant_${status}`,
  client: { clientId: 'client_1', clientName: 'Codex', installationFingerprint: 'fingerprint' },
  scopes: ['board.read'],
  lifecyclePermissions: [],
  boardIds: ['board_1'],
  lifetime: 'session',
  status,
  createdAt: '2026-07-19T00:00:00.000Z',
  activatedAt: status === 'active' ? '2026-07-19T00:00:01.000Z' : null,
  lastUsedAt: null,
  expiresAt: '2026-07-20T00:00:00.000Z',
  revokedAt: status === 'revoked' ? '2026-07-19T00:00:02.000Z' : null,
});

test('approved client list retains live grants and removes terminal grants', () => {
  const statuses: GrantSummary['status'][] = ['pending_redemption', 'active', 'revoked', 'expired'];
  assert.deepEqual(
    visibleApprovedGrants(statuses.map(grant)).map(({ status }) => status),
    ['pending_redemption', 'active'],
  );
  assert.equal(hasVisibleGrantForBoard([grant('active')], 'board_1'), true);
  assert.equal(hasVisibleGrantForBoard([grant('pending_redemption')], 'board_1'), true);
  assert.equal(hasVisibleGrantForBoard([grant('revoked')], 'board_1'), false);
  assert.equal(hasVisibleGrantForBoard([grant('active')], 'board_2'), false);
});

test('board deletion is a confirmed archive and redirects only after success', () => {
  const control = source('components/board/BoardArchiveControl.tsx');
  const client = source('app/boards/[boardId]/board-client.tsx');
  assert.match(control, /requestIdentity\.current \?\?= createBoardRequestIdentity\(\)/u);
  assert.match(
    control,
    /api\.archiveBoard\(\{[\s\S]*\.\.\.requestIdentity\.current,[\s\S]*signal/u,
  );
  assert.match(control, /controller\.signal\.aborted/u);
  assert.match(control, /<ConfirmationDialog/u);
  assert.match(control, /onArchived\(\)/u);
  assert.match(client, /onArchived=\{\(\) => router\.replace\('\/boards'\)\}/u);
  assert.match(client, /closeAndClearOwnerAdmin/u);
});

test('client disconnect requires confirmation and removes the successful grant immediately', () => {
  const list = source('app/settings/ai-connections/grant-list.tsx');
  const client = source('app/settings/ai-connections/ai-connections-client.tsx');
  assert.match(list, /setDisconnecting\(grant\)/u);
  assert.match(list, /<ConfirmationDialog/u);
  assert.match(client, /currentGrants\.filter\(\(grant\) => grant\.grantId !== grantId\)/u);
});
