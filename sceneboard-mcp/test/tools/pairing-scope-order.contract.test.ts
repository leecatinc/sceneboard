import assert from 'node:assert/strict';
import test from 'node:test';

import { PairRequestInputSchemaV1 } from '../../src/tools/connection.tools.js';

const completeRequest = {
  code: 'SB-ABCDEF-GHJKMN',
  clientName: 'SceneBoard QA',
  requestedScopes: [
    'board.read',
    'board.write',
    'board.history.read',
    'board.hitl.request',
    'board.hitl.respond',
    'board.media.write',
    'artifact.publish',
    'artifact.control',
  ],
  requestedLifecyclePermissions: ['board.create', 'board.archive'],
} as const;

test('accepts the complete official pairing scope order and ordered subsets', () => {
  assert.equal(PairRequestInputSchemaV1.safeParse(completeRequest).success, true);
  assert.equal(
    PairRequestInputSchemaV1.safeParse({
      ...completeRequest,
      requestedScopes: ['board.read', 'board.media.write', 'artifact.control'],
      requestedLifecyclePermissions: ['board.archive'],
    }).success,
    true,
  );
});

test('rejects duplicate or reordered pairing scopes and lifecycle permissions', () => {
  for (const requestedScopes of [
    ['board.read', 'artifact.publish', 'board.media.write'],
    ['board.read', 'board.read'],
  ])
    assert.equal(
      PairRequestInputSchemaV1.safeParse({ ...completeRequest, requestedScopes }).success,
      false,
    );
  assert.equal(
    PairRequestInputSchemaV1.safeParse({
      ...completeRequest,
      requestedLifecyclePermissions: ['board.archive', 'board.create'],
    }).success,
    false,
  );
});
