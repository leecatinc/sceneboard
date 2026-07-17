import type { ArtifactReferenceV1 } from '@leecat-board/board-schema';

import {
  parseArtifactBridgeEnvelopeV1,
  type ArtifactBridgeEnvelopeV1,
  type ArtifactBridgeMessageV1,
  type ArtifactBridgeTransfersV1,
  type Base64Url22,
  type ParsedArtifactBridgeEnvelopeV1,
} from './envelope.js';

export type ArtifactBridgeEndpointInputV1 = {
  channelId: Base64Url22;
  sessionId: Base64Url22;
  artifact: ArtifactReferenceV1;
  firstOutboundSequence?: number;
  firstInboundSequence?: number;
};

export class ArtifactBridgeEndpointV1 {
  #outboundSequence: number;
  #inboundSequence: number;
  #closed = false;

  constructor(private readonly identity: ArtifactBridgeEndpointInputV1) {
    this.#outboundSequence = identity.firstOutboundSequence ?? 1;
    this.#inboundSequence = identity.firstInboundSequence ?? 1;
  }

  send(message: ArtifactBridgeMessageV1, transfers: ArtifactBridgeTransfersV1 = { messagePorts: 0, arrayBufferBytes: [] }): ArtifactBridgeEnvelopeV1 {
    if (this.#closed) throw new TypeError('bridge endpoint is closed');
    const envelope: ArtifactBridgeEnvelopeV1 = {
      protocolVersion: 1,
      type: 'artifact.bridge',
      channelId: this.identity.channelId,
      sessionId: this.identity.sessionId,
      artifact: this.identity.artifact,
      sequence: this.#outboundSequence,
      message,
    };
    parseArtifactBridgeEnvelopeV1(envelope, transfers);
    this.#outboundSequence += 1;
    return envelope;
  }

  receive(input: unknown, transfers: ArtifactBridgeTransfersV1 = { messagePorts: 0, arrayBufferBytes: [] }): ParsedArtifactBridgeEnvelopeV1 {
    if (this.#closed) throw new TypeError('bridge endpoint is closed');
    const parsed = parseArtifactBridgeEnvelopeV1(input, transfers);
    const { envelope } = parsed;
    if (envelope.channelId !== this.identity.channelId
      || envelope.sessionId !== this.identity.sessionId
      || envelope.artifact.artifactId !== this.identity.artifact.artifactId
      || envelope.artifact.versionId !== this.identity.artifact.versionId) {
      throw new TypeError('bridge endpoint identity mismatch');
    }
    if (envelope.sequence !== this.#inboundSequence) throw new TypeError('bridge sequence is not contiguous');
    this.#inboundSequence += 1;
    return parsed;
  }

  close(): void {
    this.#closed = true;
  }

  get closed(): boolean {
    return this.#closed;
  }
}
