import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  BoardAuthorizationCapabilityV1,
  BoardSessionAccessV1,
} from '@sceneboard/board-schema';

import {
  capabilitySettlementIsCurrentV1,
  deriveBoardAffordancesV1,
  type BoardCapabilityRequestIdentityV1,
} from '../../lib/board/board-capabilities';

const access = (
  authorizationCapabilities: BoardAuthorizationCapabilityV1[],
  lifecyclePermissions: Array<'board.archive' | 'board.create'> = [],
): BoardSessionAccessV1 => ({
  protocolVersion: 1,
  type: 'board.session.access',
  capabilityEpoch: 4,
  authorizationCapabilities,
  connectionGrantCeiling: {
    scopes: authorizationCapabilities.includes('connection.manage.own')
      ? [
          'artifact.control',
          'artifact.publish',
          'board.history.read',
          'board.hitl.request',
          'board.hitl.respond',
          'board.read',
          'board.write',
        ]
      : [],
    lifecyclePermissions,
  },
});

const viewer = access(['board.read']);
const editor = access([
  'artifact.control',
  'artifact.publish',
  'board.history.read',
  'board.hitl.request',
  'board.hitl.respond',
  'board.media.write',
  'board.read',
  'board.write',
  'connection.manage.own',
]);
const owner = access(
  [
    'artifact.control',
    'artifact.publish',
    'board.admin',
    'board.analytics.read',
    'board.history.read',
    'board.hitl.request',
    'board.hitl.respond',
    'board.media.write',
    'board.members.manage',
    'board.read',
    'board.share.manage',
    'board.write',
    'connection.manage.own',
  ],
  ['board.archive', 'board.create'],
);

test('literal server capabilities expose the exact viewer, editor, and owner outcomes', () => {
  assert.deepEqual(deriveBoardAffordancesV1(viewer), {
    'current.read': true,
    'history.read': false,
    'board.write': false,
    'media.upload': false,
    'scene.restore': false,
    'connection.create': false,
    'connection.update': false,
    'connection.revoke': false,
    'membership.manage': false,
    'share.manage': false,
    'analytics.read': false,
    'board.archive': false,
    'board.delete': false,
  });
  assert.deepEqual(deriveBoardAffordancesV1(editor), {
    'current.read': true,
    'history.read': true,
    'board.write': true,
    'media.upload': true,
    'scene.restore': true,
    'connection.create': true,
    'connection.update': true,
    'connection.revoke': true,
    'membership.manage': false,
    'share.manage': false,
    'analytics.read': false,
    'board.archive': false,
    'board.delete': false,
  });
  assert.deepEqual(deriveBoardAffordancesV1(owner), {
    'current.read': true,
    'history.read': true,
    'board.write': true,
    'media.upload': true,
    'scene.restore': true,
    'connection.create': true,
    'connection.update': true,
    'connection.revoke': true,
    'membership.manage': true,
    'share.manage': true,
    'analytics.read': true,
    'board.archive': true,
    'board.delete': true,
  });
});

test('capability checks do not infer role names or expand capability prefixes', () => {
  const forged = access(['board.read', 'board.write']);
  const affordances = deriveBoardAffordancesV1(forged);
  assert.equal(affordances['board.write'], true);
  assert.equal(affordances['history.read'], false);
  assert.equal(affordances['share.manage'], false);
  assert.equal(affordances['membership.manage'], false);
  assert.equal(affordances['board.delete'], false);
});

test('late settlements require the exact UI epoch, board, and action identity', () => {
  const current: BoardCapabilityRequestIdentityV1 = {
    uiEpoch: 8,
    boardId: 'board_1',
    action: 'connection.update',
  };
  assert.equal(capabilitySettlementIsCurrentV1(current, current), true);
  assert.equal(capabilitySettlementIsCurrentV1({ ...current, uiEpoch: 7 }, current), false);
  assert.equal(capabilitySettlementIsCurrentV1({ ...current, boardId: 'board_2' }, current), false);
  assert.equal(
    capabilitySettlementIsCurrentV1({ ...current, action: 'connection.revoke' }, current),
    false,
  );
});
