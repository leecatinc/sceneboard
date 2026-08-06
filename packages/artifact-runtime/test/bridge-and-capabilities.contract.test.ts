import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ArtifactReferenceV1 } from '@sceneboard/board-schema';

import {
  ArtifactBridgeEndpointV1,
  ArtifactHostStateMachineV1,
  parseArtifactBridgeEnvelopeV1,
} from '../src/bridge/index.js';
import { decideArtifactCapabilityV1 } from '../src/policy/index.js';

const ID = 'abcdefghijklmnopqrstuv';
const artifact = { artifactId: 'artifact_one', versionId: 'version_one' } as ArtifactReferenceV1;
const bootstrap = {
  protocolVersion: 1,
  type: 'artifact.bridge',
  channelId: ID,
  sessionId: ID,
  artifact,
  sequence: 1,
  message: {
    type: 'host.bootstrap',
    appOrigin: 'http://127.0.0.1:3410',
    runtimeOrigin: 'http://127.0.0.2:3412',
    policyEpoch: ID,
  },
} as const;

test('bridge parser enforces exact schema and transfer list', () => {
  assert.equal(
    parseArtifactBridgeEnvelopeV1(bootstrap, { messagePorts: 1, arrayBufferBytes: [] }).envelope
      .sequence,
    1,
  );
  assert.throws(
    () =>
      parseArtifactBridgeEnvelopeV1(
        { ...bootstrap, unknown: true },
        { messagePorts: 1, arrayBufferBytes: [] },
      ),
    /keys/u,
  );
  assert.throws(() => parseArtifactBridgeEnvelopeV1(bootstrap), /transfer/u);
});

test('bridge parser closes navigation and sourced resize shapes', () => {
  const sender = new ArtifactBridgeEndpointV1({ channelId: ID, sessionId: ID, artifact });
  assert.equal(
    sender.send({ type: 'host.navigation.set', enabled: true }).message.type,
    'host.navigation.set',
  );
  assert.equal(
    sender.send({ type: 'host.presentation', active: true }).message.type,
    'host.presentation',
  );
  assert.equal(
    sender.send({
      type: 'artifact.navigation.wheel',
      xMillionth: 500_000,
      yMillionth: 0,
      deltaY: 0.25,
    }).message.type,
    'artifact.navigation.wheel',
  );
  assert.equal(
    sender.send({
      type: 'artifact.resize.request',
      value: { width: 1_200, height: 675, source: 'observer' },
    }).message.type,
    'artifact.resize.request',
  );
  assert.deepEqual(
    sender.send({
      type: 'artifact.presentation.page-change',
      value: { pageId: 'slide-opening', pageIndex: 0, pageCount: 7 },
    }).message,
    {
      type: 'artifact.presentation.page-change',
      value: { pageId: 'slide-opening', pageIndex: 0, pageCount: 7 },
    },
  );
  assert.throws(
    () =>
      sender.send({ type: 'artifact.navigation.wheel', xMillionth: 0, yMillionth: 0, deltaY: 0 }),
    /wheel/u,
  );
  assert.throws(
    () =>
      sender.send({
        type: 'artifact.resize.request',
        value: { width: 1_200, height: 675 },
      } as never),
    /keys/u,
  );
  assert.throws(
    () => sender.send({ type: 'host.presentation', active: 'true' } as never),
    /presentation/u,
  );
  for (const value of [
    { pageId: '../slide', pageIndex: 0, pageCount: 7 },
    { pageId: 'slide-opening', pageIndex: 7, pageCount: 7 },
    { pageId: 'slide-opening', pageIndex: 0, pageCount: 7, extra: true },
  ])
    assert.throws(
      () => sender.send({ type: 'artifact.presentation.page-change', value } as never),
      /presentation page/u,
    );
});

test('bridge endpoint rejects replay, gaps, and pair drift', () => {
  const receiver = new ArtifactBridgeEndpointV1({ channelId: ID, sessionId: ID, artifact });
  receiver.receive(bootstrap, { messagePorts: 1, arrayBufferBytes: [] });
  assert.throws(
    () => receiver.receive(bootstrap, { messagePorts: 1, arrayBufferBytes: [] }),
    /sequence/u,
  );
  const sender = new ArtifactBridgeEndpointV1({ channelId: ID, sessionId: ID, artifact });
  assert.equal(sender.send({ type: 'runner.ready', supportedProtocolVersions: [1] }).sequence, 1);
  assert.equal(sender.send({ type: 'artifact.ready' }).sequence, 2);
});

test('bridge endpoint rejects same-realm validation-time message mutation', () => {
  const sender = new ArtifactBridgeEndpointV1({ channelId: ID, sessionId: ID, artifact });
  const nativeOwnKeys = Reflect.ownKeys;
  let mutated = false;
  Reflect.ownKeys = (value: object): (string | symbol)[] => {
    if (
      !mutated &&
      value !== null &&
      typeof value === 'object' &&
      'type' in value &&
      value.type === 'artifact.bridge'
    ) {
      (value as { message: unknown }).message = {
        type: 'artifact.navigation.wheel',
        xMillionth: 1,
        yMillionth: 2,
        deltaY: 3,
      };
      mutated = true;
    }
    return nativeOwnKeys(value);
  };
  try {
    assert.throws(
      () =>
        sender.send({
          type: 'artifact.resize.request',
          value: { width: 1_200, height: 675, source: 'explicit' },
        }),
      /mutated/u,
    );
  } finally {
    Reflect.ownKeys = nativeOwnKeys;
  }
});

test('bridge endpoint admits only the built-in responsive fixed-canvas resize mode', () => {
  const sender = new ArtifactBridgeEndpointV1({ channelId: ID, sessionId: ID, artifact });
  assert.doesNotThrow(() =>
    sender.send({
      type: 'artifact.resize.request',
      value: {
        width: 1_920,
        height: 1_080,
        source: 'explicit',
        renderMode: 'responsive-fixed-canvas',
      },
    }),
  );
  assert.throws(
    () =>
      sender.send({
        type: 'artifact.resize.request',
        value: {
          width: 1_920,
          height: 1_080,
          source: 'explicit',
          renderMode: 'untrusted-mode',
        } as never,
      }),
    /render mode/u,
  );
});

test('host lifecycle has only named legal edges', () => {
  const machine = new ArtifactHostStateMachineV1();
  assert.equal(machine.advance('mount'), 'outer_bootstrap');
  assert.equal(machine.advance('runner.ready'), 'runner_ready');
  assert.equal(machine.advance('package.start'), 'package_transfer');
  assert.equal(machine.advance('package.ready'), 'outer_certified');
  assert.equal(machine.advance('inner.start'), 'inner_handshake');
  assert.equal(machine.advance('artifact.ready'), 'active');
  assert.throws(() => machine.advance('runner.ready'), /illegal/u);
});

test('capabilities are the default-denied policy intersection', () => {
  assert.deepEqual(
    decideArtifactCapabilityV1({
      capability: 'clipboard.write',
      manifestRequested: [],
      currentlyAllowed: ['clipboard.write'],
      policyEpochMatches: true,
    }),
    { ok: false, error: 'not_requested' },
  );
  assert.deepEqual(
    decideArtifactCapabilityV1({
      capability: 'network.fetch',
      manifestRequested: ['network.fetch'],
      currentlyAllowed: ['network.fetch'],
      policyEpochMatches: true,
    }),
    { ok: false, error: 'unavailable' },
  );
  assert.deepEqual(
    decideArtifactCapabilityV1({
      capability: 'fullscreen',
      manifestRequested: ['fullscreen'],
      currentlyAllowed: ['fullscreen'],
      policyEpochMatches: true,
    }),
    { ok: true, capability: 'fullscreen' },
  );
});
