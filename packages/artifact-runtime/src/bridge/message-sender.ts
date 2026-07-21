import type { ArtifactBridgeEnvelopeV1, ArtifactBridgeMessageV1 } from './envelope.js';
import type { ArtifactBridgeEndpointV1 } from './endpoint.js';

export type ArtifactBridgeBinaryCarrierV1 = Readonly<{
  envelope: ArtifactBridgeEnvelopeV1;
  binary: ArrayBuffer;
}>;

export type ArtifactBridgePostMessageV1 = (
  message: ArtifactBridgeEnvelopeV1 | ArtifactBridgeBinaryCarrierV1,
  transfer: Transferable[],
) => void;

export const postArtifactBridgeMessageV1 = (
  endpoint: ArtifactBridgeEndpointV1,
  postMessage: ArtifactBridgePostMessageV1,
  message: ArtifactBridgeMessageV1,
  binary?: ArrayBuffer,
): void => {
  const expectedType = message.type;
  if (binary === undefined) {
    const envelope = endpoint.send(message);
    if (envelope.message !== message || envelope.message.type !== expectedType)
      throw new TypeError('artifact bridge send was mutated');
    postMessage(envelope, []);
    return;
  }
  const envelope = endpoint.send(message, {
    messagePorts: 0,
    arrayBufferBytes: [binary.byteLength],
  });
  if (envelope.message !== message || envelope.message.type !== expectedType)
    throw new TypeError('artifact bridge send was mutated');
  postMessage({ envelope, binary }, [binary]);
};
