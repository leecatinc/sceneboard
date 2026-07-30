import assert from 'node:assert/strict';
import { MessageChannel } from 'node:worker_threads';
import test from 'node:test';

import {
  ArtifactBridgeEndpointV1,
  type ArtifactNavigationIntentV1,
} from '@sceneboard/artifact-runtime/bridge';
import type { ArtifactReferenceV1 } from '@sceneboard/board-schema';
import { dispatchArtifactNavigationIntentV1 } from '../../src/artifact/navigation-dispatch.js';

const identity = {
  channelId: 'AAAAAAAAAAAAAAAAAAAAAA',
  sessionId: 'BBBBBBBBBBBBBBBBBBBBBB',
  artifact: { artifactId: 'artifact_one', versionId: 'version_one' } as ArtifactReferenceV1,
} as const;

test('actual mode dispatches a navigation message received over a real channel exactly once', async () => {
  const sender = new ArtifactBridgeEndpointV1(identity);
  const receiver = new ArtifactBridgeEndpointV1(identity);
  const channel = new MessageChannel();
  const received: ArtifactNavigationIntentV1[] = [];
  const intent = {
    type: 'artifact.navigation.wheel',
    xMillionth: 500_000,
    yMillionth: 250_000,
    deltaY: -120,
  } as const;

  const settled = new Promise<void>((resolve, reject) => {
    channel.port2.once('message', (raw) => {
      try {
        const message = receiver.receive(raw).envelope.message;
        assert.equal(message.type, 'artifact.navigation.wheel');
        assert.equal(
          dispatchArtifactNavigationIntentV1('actual', message, (value) => received.push(value)),
          true,
        );
        resolve();
      } catch (error) {
        reject(error);
      }
    });
  });
  channel.port1.postMessage(sender.send(intent));
  await settled;
  assert.deepEqual(received, [intent]);
  channel.port1.close();
  channel.port2.close();
});

test('fit modes suppress navigation without invoking the callback', () => {
  const intent = { type: 'artifact.navigation.pan.cancel', pointerId: 7 } as const;
  let calls = 0;
  assert.equal(
    dispatchArtifactNavigationIntentV1('fit-page', intent, () => {
      calls += 1;
    }),
    false,
  );
  assert.equal(
    dispatchArtifactNavigationIntentV1('fit-width', intent, () => {
      calls += 1;
    }),
    false,
  );
  assert.equal(calls, 0);
});
