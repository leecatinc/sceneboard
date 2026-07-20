import assert from 'node:assert/strict';
import { MessageChannel } from 'node:worker_threads';
import test from 'node:test';

import { ArtifactBridgeEndpointV1, postArtifactBridgeMessageV1 } from '../src/bridge/index.js';
import type { ArtifactReferenceV1 } from '@leecat-board/board-schema';

const identity = {
  channelId: 'AAAAAAAAAAAAAAAAAAAAAA',
  sessionId: 'BBBBBBBBBBBBBBBBBBBBBB',
  artifact: { artifactId: 'artifact_one', versionId: 'version_one' } as ArtifactReferenceV1,
} as const;

test('download capability crosses a real MessageChannel with the exact transferable bytes', async () => {
  const sender = new ArtifactBridgeEndpointV1(identity);
  const receiver = new ArtifactBridgeEndpointV1(identity);
  const channel = new MessageChannel();
  const binary = new Uint8Array([1, 3, 5, 7]).buffer;
  const request = {
    type: 'artifact.capability.request',
    requestId: 'CCCCCCCCCCCCCCCCCCCCCC',
    capability: 'download',
    payload: { byteLength: 4, filename: 'demo.bin' },
  } as const;

  const settled = new Promise<void>((resolve, reject) => {
    channel.port2.once('message', (carrier) => {
      try {
        assert.ok(carrier.binary instanceof ArrayBuffer);
        const parsed = receiver.receive(carrier.envelope, { messagePorts: 0, arrayBufferBytes: [carrier.binary.byteLength] });
        assert.deepEqual(parsed.envelope.message, request);
        assert.deepEqual([...new Uint8Array(carrier.binary)], [1, 3, 5, 7]);
        resolve();
      } catch (error) { reject(error); }
    });
  });
  postArtifactBridgeMessageV1(sender, channel.port1.postMessage.bind(channel.port1), request, binary);
  assert.equal(binary.byteLength, 0);
  await settled;
  channel.port1.close();
  channel.port2.close();
});

test('download without bytes and non-download with bytes fail before posting', () => {
  const sender = new ArtifactBridgeEndpointV1(identity);
  const posted: unknown[] = [];
  assert.throws(() => postArtifactBridgeMessageV1(sender, (value) => posted.push(value), {
    type: 'artifact.capability.request', requestId: 'CCCCCCCCCCCCCCCCCCCCCC', capability: 'download', payload: { byteLength: 4 },
  }));
  assert.throws(() => postArtifactBridgeMessageV1(sender, (value) => posted.push(value), {
    type: 'artifact.capability.request', requestId: 'DDDDDDDDDDDDDDDDDDDDDD', capability: 'network.fetch', payload: {},
  }, new ArrayBuffer(4)));
  assert.equal(posted.length, 0);
});
