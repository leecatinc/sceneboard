import assert from 'node:assert/strict';
import test from 'node:test';

import { ArtifactRateBudgetV1, isChargedAuthoredMessageV1 } from '../src/bridge/index.js';
import type { ArtifactBridgeMessageV1 } from '../src/bridge/index.js';

test('classifies exactly the six authored budget message types', () => {
  const charged = [
    'artifact.ready',
    'artifact.resize.request',
    'artifact.presentation.page-change',
    'artifact.selection.change',
    'artifact.user-action',
    'artifact.capability.request',
  ] as const;
  const everyType = [
    'host.bootstrap',
    'runner.ready',
    'host.package.start',
    'host.package.chunk',
    'runner.package.ack',
    'host.package.end',
    'runner.package.ready',
    'host.watchdog.ping',
    'runner.watchdog.pong',
    'host.inner.init',
    'artifact.ready',
    'host.theme',
    'host.data',
    'host.viewport',
    'host.selection',
    'host.presentation',
    'host.navigation.set',
    'artifact.navigation.wheel',
    'artifact.navigation.pan.start',
    'artifact.navigation.pan.move',
    'artifact.navigation.pan.end',
    'artifact.navigation.pan.cancel',
    'artifact.resize.request',
    'artifact.presentation.page-change',
    'artifact.selection.change',
    'artifact.user-action',
    'artifact.capability.request',
    'host.capability.result',
    'host.dispose',
    'peer.disposed',
    'protocol.error',
  ] as const satisfies readonly ArtifactBridgeMessageV1['type'][];
  const chargedSet = new Set<ArtifactBridgeMessageV1['type']>(charged);
  type MissingType = Exclude<ArtifactBridgeMessageV1['type'], (typeof everyType)[number]>;
  const exhaustive: MissingType extends never ? true : never = true;
  assert.equal(exhaustive, true);
  assert.equal(new Set(everyType).size, everyType.length);
  for (const type of everyType)
    assert.equal(isChargedAuthoredMessageV1({ type }), chargedSet.has(type), type);
});

test('admits exact count and byte boundaries atomically', () => {
  let now = 0;
  const budget = new ArtifactRateBudgetV1({
    countRate: 1,
    countBurst: 2,
    byteRate: 10,
    byteBurst: 20,
    now: () => now,
  });
  assert.equal(budget.admit(10), true);
  assert.equal(budget.admit(10), true);
  assert.equal(budget.admit(0), false);
  now = 1_000;
  assert.equal(budget.admit(10), true);
});

test('does not spend either bucket when one charge is unavailable', () => {
  let now = 0;
  const budget = new ArtifactRateBudgetV1({
    countRate: 0,
    countBurst: 1,
    byteRate: 0,
    byteBurst: 5,
    now: () => now,
  });
  assert.equal(budget.admit(6), false);
  assert.equal(budget.admit(5), true);
  now = 1;
  assert.equal(budget.admit(0), false);
});

test('rejects invalid charge and clock values', () => {
  const budget = new ArtifactRateBudgetV1({
    countRate: 1,
    countBurst: 1,
    byteRate: 1,
    byteBurst: 1,
    now: () => 0,
  });
  assert.equal(budget.admit(-1), false);
  assert.equal(budget.admit(0.5), false);
  assert.throws(
    () =>
      new ArtifactRateBudgetV1({
        countRate: 1,
        countBurst: 1,
        byteRate: 1,
        byteBurst: 1,
        now: () => Number.NaN,
      }),
    /clock/u,
  );
});

test('rejects a backward clock without minting duplicate refill', () => {
  let now = 1_000;
  const budget = new ArtifactRateBudgetV1({
    countRate: 1,
    countBurst: 1,
    byteRate: 10,
    byteBurst: 10,
    now: () => now,
  });
  assert.equal(budget.admit(10), true);
  now = 500;
  assert.throws(() => budget.admit(1), /backward/u);
  now = 1_000;
  assert.equal(budget.admit(1), false);
  now = 2_000;
  assert.equal(budget.admit(10), true);
});
