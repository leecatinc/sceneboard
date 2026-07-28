import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import type {
  SharePasswordResultV1,
  SharePublishResultV1,
  ShareRotateResultV1,
} from '../../lib/api/share-api';
import {
  beginShareSecretRequestV1,
  CLOSED_SHARE_SECRET_STATE_V1,
  settleShareSecretRequestV1,
} from '../../lib/board/share-secret-state';

const share = {
  shareId: 'share_1',
  status: 'active' as const,
  accessPolicy: 'L' as const,
  pinnedRevisionId: 'revision_1',
  publicationGeneration: 1,
  accessGeneration: 1,
  version: 1,
  createdAt: '2026-07-28T00:00:00.000Z',
  updatedAt: '2026-07-28T00:00:00.000Z',
};

test('one-time secret state admits only the current action and share', () => {
  const begun = beginShareSecretRequestV1(4, 'share.rotate', share.shareId);
  const accepted = settleShareSecretRequestV1(begun.request, begun.request, {
    status: 'rotated',
    share,
    linkToken: 'A'.repeat(43),
  } as ShareRotateResultV1);
  assert.equal(accepted.state.status, 'showing');
  if (accepted.state.status === 'showing') {
    assert.equal(accepted.state.linkToken, 'A'.repeat(43));
    assert.equal(accepted.state.password, null);
  }
  const wrongShare = settleShareSecretRequestV1(begun.request, begun.request, {
    status: 'rotated',
    share: { ...share, shareId: 'share_2' },
    linkToken: 'B'.repeat(43),
  } as ShareRotateResultV1);
  assert.deepEqual(wrongShare.state, CLOSED_SHARE_SECRET_STATE_V1);
  const stale = settleShareSecretRequestV1(null, begun.request, {
    status: 'rotated',
    share,
    linkToken: 'C'.repeat(43),
  } as ShareRotateResultV1);
  assert.deepEqual(stale.state, CLOSED_SHARE_SECRET_STATE_V1);
});

test('status mismatch and non-secret replay never reopen plaintext', () => {
  const publish = beginShareSecretRequestV1(0, 'share.create', null);
  const wrongAction = settleShareSecretRequestV1(publish.request, publish.request, {
    status: 'enabled',
    share: { ...share, accessPolicy: 'P' },
    password: 'A'.repeat(24),
  } as SharePasswordResultV1);
  assert.deepEqual(wrongAction.state, CLOSED_SHARE_SECRET_STATE_V1);
  const replay = settleShareSecretRequestV1(publish.request, publish.request, {
    status: 'already-created',
    shareId: share.shareId,
    copySecretAvailable: false,
    rotateRequired: true,
  } as SharePublishResultV1);
  assert.deepEqual(replay, {
    state: CLOSED_SHARE_SECRET_STATE_V1,
    recovery: 'rotate_required',
  });
});

test('share sheet keeps manual fallback visible and provides a 320px native modal sheet', () => {
  const component = readFileSync(
    new URL('../../components/board/ShareManagementSheet.tsx', import.meta.url),
    'utf8',
  );
  const css = readFileSync(
    new URL('../../components/board/ShareManagementSheet.module.css', import.meta.url),
    'utf8',
  );
  assert.match(component, /<dialog/u);
  assert.match(component, /<textarea[\s\S]*?readOnly[\s\S]*?value=\{visibleSecret\}/u);
  assert.match(component, /\.writeText\(visibleSecret\)/u);
  assert.match(component, /invalidateSecret/u);
  assert.match(css, /min-width:\s*min\(320px,\s*100vw\)/u);
});
