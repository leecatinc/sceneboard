import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BoardOperationResultParserV1, BoardSessionAccessParserV1 } from '../src/index.js';
import { loadFixture } from './helpers/load-fixture.js';

const ownerAccess = {
  protocolVersion: 1,
  type: 'board.session.access',
  capabilityEpoch: 9,
  authorizationCapabilities: [
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
  connectionGrantCeiling: {
    scopes: [
      'artifact.control',
      'artifact.publish',
      'board.history.read',
      'board.hitl.request',
      'board.hitl.respond',
      'board.read',
      'board.write',
    ],
    lifecyclePermissions: ['board.archive', 'board.create'],
  },
} as const;

test('browser session access is strict, epoch-bound, and catalog-normalized', () => {
  assert.equal(BoardSessionAccessParserV1.parse(ownerAccess).ok, true);
  assert.equal(
    BoardSessionAccessParserV1.parse({
      ...ownerAccess,
      authorizationCapabilities: ['board.write', 'board.read'],
    }).ok,
    false,
  );
  assert.equal(
    BoardSessionAccessParserV1.parse({
      ...ownerAccess,
      connectionGrantCeiling: {
        ...ownerAccess.connectionGrantCeiling,
        lifecyclePermissions: ['board.create', 'board.archive'],
      },
    }).ok,
    false,
  );
  assert.equal(BoardSessionAccessParserV1.parse({ ...ownerAccess, role: 'owner' }).ok, false);
});

test('capabilities.get requires the exact browser session access projection', async () => {
  const fixture = (await loadFixture('valid/operation-result-capabilities-get.v1.json')) as Record<
    string,
    unknown
  >;
  assert.equal(BoardOperationResultParserV1.parse(fixture).ok, true);
  const result = fixture.result as Record<string, unknown>;
  assert.equal(
    BoardOperationResultParserV1.parse({
      ...fixture,
      result: { ...result, sessionAccess: undefined },
    }).ok,
    false,
  );
});
