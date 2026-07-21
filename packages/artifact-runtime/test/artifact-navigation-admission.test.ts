import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MessageChannel } from 'node:worker_threads';

import type { ArtifactReferenceV1 } from '@sceneboard/board-schema';

import { ArtifactBridgeEndpointV1, ArtifactNavigationAdmissionV1 } from '../src/bridge/index.js';
import type { ArtifactBridgeEnvelopeV1, ArtifactBridgeMessageV1 } from '../src/bridge/index.js';

const ID = 'abcdefghijklmnopqrstuv';
const ARTIFACT = { artifactId: 'artifact_one', versionId: 'version_one' } as ArtifactReferenceV1;
const bridgeEndpoint = () =>
  new ArtifactBridgeEndpointV1({ channelId: ID, sessionId: ID, artifact: ARTIFACT });

const receiveBinaryOverChannel = async (
  envelope: ArtifactBridgeEnvelopeV1,
  byteLengths: readonly number[] | null,
  wrongKindPort = false,
): Promise<unknown> => {
  const channel = new MessageChannel();
  const receiver = bridgeEndpoint();
  const extra = wrongKindPort ? new MessageChannel() : null;
  const settled = new Promise<unknown>((resolve) => {
    channel.port1.onmessage = (event) => {
      try {
        const carrier = event.data as
          | ArtifactBridgeEnvelopeV1
          | { envelope: ArtifactBridgeEnvelopeV1; binaries: ArrayBuffer[] };
        const binaries = 'binaries' in carrier ? carrier.binaries : [];
        receiver.receive('envelope' in carrier ? carrier.envelope : carrier, {
          messagePorts: event.ports.length,
          arrayBufferBytes: binaries.map((binary) => binary.byteLength),
        });
        resolve(null);
      } catch (error) {
        resolve(error);
      } finally {
        for (const transferredPort of event.ports) transferredPort.close();
        extra?.port2.close();
        channel.port1.close();
        channel.port2.close();
      }
    };
  });
  if (wrongKindPort && extra !== null) channel.port2.postMessage(envelope, [extra.port1]);
  else if (byteLengths === null) channel.port2.postMessage(envelope);
  else {
    const binaries = byteLengths.map((byteLength) => new ArrayBuffer(byteLength));
    channel.port2.postMessage({ envelope, binaries }, binaries);
  }
  return settled;
};

const receiveBinaryInsteadOfPortOverChannel = async (
  envelope: ArtifactBridgeEnvelopeV1,
): Promise<unknown> => {
  const channel = new MessageChannel();
  const receiver = bridgeEndpoint();
  const settled = new Promise<unknown>((resolve) => {
    channel.port1.onmessage = (event) => {
      try {
        const carrier = event.data as { envelope: ArtifactBridgeEnvelopeV1; binary: ArrayBuffer };
        receiver.receive(carrier.envelope, {
          messagePorts: event.ports.length,
          arrayBufferBytes: [carrier.binary.byteLength],
        });
        resolve(null);
      } catch (error) {
        resolve(error);
      } finally {
        channel.port1.close();
        channel.port2.close();
      }
    };
  });
  const binary = new ArrayBuffer(4);
  channel.port2.postMessage({ envelope, binary }, [binary]);
  return settled;
};

const receivePortsOverChannel = async (
  envelope: ArtifactBridgeEnvelopeV1,
  portCount: number,
): Promise<unknown> => {
  const channel = new MessageChannel();
  const receiver = bridgeEndpoint();
  const extras = Array.from({ length: portCount }, () => new MessageChannel());
  const settled = new Promise<unknown>((resolve) => {
    channel.port1.onmessage = (event) => {
      try {
        receiver.receive(event.data, { messagePorts: event.ports.length, arrayBufferBytes: [] });
        resolve(null);
      } catch (error) {
        resolve(error);
      } finally {
        for (const port of event.ports) port.close();
        for (const extra of extras) extra.port2.close();
        channel.port1.close();
        channel.port2.close();
      }
    };
  });
  channel.port2.postMessage(
    envelope,
    extras.map((extra) => extra.port1),
  );
  return settled;
};

test('navigation admission enforces armed active and exact pointer lifecycle', () => {
  const admission = new ArtifactNavigationAdmissionV1();
  const start = {
    type: 'artifact.navigation.pan.start',
    pointerId: 7,
    xMillionth: 1,
    yMillionth: 2,
  } as const;
  assert.equal(admission.admit(start, true), false);
  admission.setEnabled(true);
  assert.equal(admission.admit(start, false), false);
  assert.equal(admission.admit(start, true), true);
  assert.equal(
    admission.admit(
      { type: 'artifact.navigation.pan.move', pointerId: 8, deltaX: 1, deltaY: 1 },
      true,
    ),
    false,
  );
  assert.equal(
    admission.admit(
      { type: 'artifact.navigation.wheel', xMillionth: 1, yMillionth: 2, deltaY: 1 },
      true,
    ),
    false,
  );
  assert.equal(admission.setEnabled(false), null);
  assert.equal(
    admission.admit(
      { type: 'artifact.navigation.pan.move', pointerId: 7, deltaX: 1, deltaY: 1 },
      true,
    ),
    false,
  );
  assert.equal(
    admission.admit({ type: 'artifact.navigation.pan.cancel', pointerId: 7 }, true),
    true,
  );
  assert.equal(
    admission.admit(
      { type: 'artifact.navigation.pan.end', pointerId: 7, deltaX: 0, deltaY: 0 },
      true,
    ),
    false,
  );
  assert.equal(admission.setEnabled(false), null);
});

test('message channel receiver rejects an undeclared transferred port', async () => {
  const sender = bridgeEndpoint();
  const receiver = bridgeEndpoint();
  const channel = new MessageChannel();
  const extra = new MessageChannel();
  const envelope = sender.send({ type: 'host.navigation.set', enabled: true });
  const result = new Promise<unknown>((resolve) => {
    channel.port1.onmessage = (event) => {
      try {
        receiver.receive(event.data, { messagePorts: event.ports.length, arrayBufferBytes: [] });
        resolve(null);
      } catch (error) {
        resolve(error);
      }
    };
  });
  channel.port2.postMessage(envelope, [extra.port1]);
  assert.match(String(await result), /transfer/u);
  channel.port1.close();
  channel.port2.close();
  extra.port2.close();
});

test('message channel preserves an exact capability binary carrier', async () => {
  const sender = bridgeEndpoint();
  const receiver = bridgeEndpoint();
  const channel = new MessageChannel();
  const binary = new Uint8Array([1, 2, 3, 4]).buffer;
  const envelope = sender.send(
    {
      type: 'host.capability.result',
      requestId: ID,
      capability: 'network.fetch',
      ok: true,
      result: { byteLength: 4 },
    },
    { messagePorts: 0, arrayBufferBytes: [4] },
  );
  const result = new Promise<{ type: string; bytes: number[] }>((resolve, reject) => {
    channel.port1.onmessage = (event) => {
      try {
        const carrier = event.data as { envelope: unknown; binary: ArrayBuffer };
        const parsed = receiver.receive(carrier.envelope, {
          messagePorts: event.ports.length,
          arrayBufferBytes: [carrier.binary.byteLength],
        });
        resolve({ type: parsed.envelope.message.type, bytes: [...new Uint8Array(carrier.binary)] });
      } catch (error) {
        reject(error);
      }
    };
  });
  channel.port2.postMessage({ envelope, binary }, [binary]);
  assert.deepEqual(await result, { type: 'host.capability.result', bytes: [1, 2, 3, 4] });
  channel.port1.close();
  channel.port2.close();
});

test('every binary transfer branch rejects missing, extra, and wrong byte lengths through parser and real channels', async () => {
  const branches = [
    {
      name: 'package chunk',
      message: { type: 'host.package.chunk', transferId: ID, index: 0, offset: 0, byteLength: 4 },
    },
    {
      name: 'download request',
      message: {
        type: 'artifact.capability.request',
        requestId: ID,
        capability: 'download',
        payload: { byteLength: 4 },
      },
    },
    {
      name: 'network result',
      message: {
        type: 'host.capability.result',
        requestId: ID,
        capability: 'network.fetch',
        ok: true,
        result: { byteLength: 4 },
      },
    },
  ] as const satisfies readonly { name: string; message: ArtifactBridgeMessageV1 }[];

  for (const branch of branches) {
    const envelope = bridgeEndpoint().send(branch.message, {
      messagePorts: 0,
      arrayBufferBytes: [4],
    });
    for (const bytes of [[], [4, 1], [3], [5]] as const) {
      assert.throws(
        () => bridgeEndpoint().receive(envelope, { messagePorts: 0, arrayBufferBytes: bytes }),
        /transfer/u,
        `${branch.name}: ${bytes.join(',')}`,
      );
    }
    assert.throws(
      () => bridgeEndpoint().receive(envelope, { messagePorts: 1, arrayBufferBytes: [] }),
      /transfer/u,
      `${branch.name}: wrong parser transfer kind`,
    );
    assert.match(
      String(await receiveBinaryOverChannel(envelope, null)),
      /transfer/u,
      `${branch.name}: missing real binary`,
    );
    assert.match(
      String(await receiveBinaryOverChannel(envelope, [4, 1])),
      /transfer/u,
      `${branch.name}: extra real binary`,
    );
    assert.match(
      String(await receiveBinaryOverChannel(envelope, [5])),
      /transfer/u,
      `${branch.name}: wrong real binary`,
    );
    assert.match(
      String(await receiveBinaryOverChannel(envelope, null, true)),
      /transfer/u,
      `${branch.name}: wrong real transfer kind`,
    );
    assert.equal(
      await receiveBinaryOverChannel(envelope, [4]),
      null,
      `${branch.name}: exact real binary`,
    );
  }
});

test('every port transfer branch rejects missing and extra ports through parser and real channels', async () => {
  const branches = [
    {
      type: 'host.bootstrap',
      appOrigin: 'https://sceneboard.dev',
      runtimeOrigin: 'https://artifact.sceneboard.dev',
      policyEpoch: ID,
    },
    { type: 'host.inner.init', policyEpoch: ID, requestedCapabilities: [] },
  ] as const satisfies readonly ArtifactBridgeMessageV1[];

  for (const message of branches) {
    const envelope = bridgeEndpoint().send(message, { messagePorts: 1, arrayBufferBytes: [] });
    for (const ports of [0, 2]) {
      assert.throws(
        () => bridgeEndpoint().receive(envelope, { messagePorts: ports, arrayBufferBytes: [] }),
        /transfer/u,
        `${message.type}: ${ports}`,
      );
      assert.match(
        String(await receivePortsOverChannel(envelope, ports)),
        /transfer/u,
        `${message.type}: ${ports} real ports`,
      );
    }
    assert.throws(
      () => bridgeEndpoint().receive(envelope, { messagePorts: 0, arrayBufferBytes: [4] }),
      /transfer/u,
      `${message.type}: wrong parser transfer kind`,
    );
    assert.match(
      String(await receiveBinaryInsteadOfPortOverChannel(envelope)),
      /transfer/u,
      `${message.type}: wrong real transfer kind`,
    );
    assert.equal(
      await receivePortsOverChannel(envelope, 1),
      null,
      `${message.type}: exact real port`,
    );
  }
});
