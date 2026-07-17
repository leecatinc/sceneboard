import assert from 'node:assert/strict';
import test from 'node:test';

import type { BoardId, PrincipalId } from '@leecat-board/board-schema';

import {
  AuthorizedBrowserPresenceService,
  type BrowserPresenceStatusReaderV1,
} from '../../src/presence/authorized-browser-presence.service.js';
import type { AuthorizedBoardContextV1 } from '../../src/grants/board-access.policy.js';

const BOARD_ID = 'board_1' as BoardId;

const context = (ownerUserPk = 1n): AuthorizedBoardContextV1 => ({
  actor: {
    principalKind: 'user',
    principalId: 'user_1' as PrincipalId,
    grantId: null,
    scopes: ['board.read'],
  },
  ownerUserPk,
  access: { kind: 'owner', ownerUserPk },
  createBinding: null,
  artifactCapabilityPolicy: { allowedArtifactRequestCapabilities: [], policyEpoch: 'epoch_1' },
});

test('capture is zero-I/O and status consumes the sealed subject exactly once', async () => {
  const seen: Array<{ boardId: BoardId; ownerUserPk: bigint }> = [];
  const reader: BrowserPresenceStatusReaderV1 = {
    getStatus: async (input) => {
      seen.push(input);
      return 'online';
    },
  };
  const service = new AuthorizedBrowserPresenceService(reader);
  const subject = service.captureAuthorizedSubject(context(), BOARD_ID);
  assert.notEqual(subject, null);
  assert.deepEqual(seen, []);
  if (subject === null) return;
  assert.equal(await service.getStatus(subject), 'online');
  assert.deepEqual(seen, [{ boardId: BOARD_ID, ownerUserPk: 1n }]);
  assert.equal(await service.getStatus(subject), 'unknown');
  assert.equal(seen.length, 1);
});

test('invalid owner bindings and forged subjects fail closed without reader I/O', async () => {
  let calls = 0;
  const service = new AuthorizedBrowserPresenceService({
    getStatus: async () => {
      calls += 1;
      return 'offline';
    },
  });
  const mismatched = context();
  mismatched.access = { kind: 'owner', ownerUserPk: 2n };
  assert.equal(service.captureAuthorizedSubject(mismatched, BOARD_ID), null);
  assert.equal(await service.getStatus(Object.freeze({}) as never), 'unknown');
  assert.equal(calls, 0);
});

test('reader failures and unstable status values remain unknown', async () => {
  const failing = new AuthorizedBrowserPresenceService({
    getStatus: async () => {
      throw new Error('redis unavailable');
    },
  });
  const subject = failing.captureAuthorizedSubject(context(), BOARD_ID);
  assert.notEqual(subject, null);
  if (subject !== null) assert.equal(await failing.getStatus(subject), 'unknown');
});
