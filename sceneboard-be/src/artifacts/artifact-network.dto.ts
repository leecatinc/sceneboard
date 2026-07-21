import { ArtifactBrokerError } from '../common/errors/artifact-broker.error.js';

export type ArtifactNetworkFetchRequestV1 = {
  protocolVersion: 1;
  type: 'artifact.network.fetch.request';
  requestId: string;
  method: 'GET' | 'HEAD';
  url: string;
};

export const parseArtifactNetworkFetchRequestV1 = (
  value: unknown,
): ArtifactNetworkFetchRequestV1 => {
  const fallbackRequestId = 'AAAAAAAAAAAAAAAAAAAAAA';
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ArtifactBrokerError('INVALID_REQUEST', fallbackRequestId);
  }
  const source = value as Record<string, unknown>;
  const descriptors = Object.getOwnPropertyDescriptors(source);
  const keys = Object.keys(source);
  const requestId =
    typeof source.requestId === 'string' && /^[A-Za-z0-9_-]{22}$/u.test(source.requestId)
      ? source.requestId
      : fallbackRequestId;
  if (
    keys.length !== 5 ||
    keys.some((key) => !['protocolVersion', 'type', 'requestId', 'method', 'url'].includes(key)) ||
    Object.values(descriptors).some(
      (descriptor) => descriptor.get !== undefined || descriptor.set !== undefined,
    ) ||
    source.protocolVersion !== 1 ||
    source.type !== 'artifact.network.fetch.request' ||
    requestId !== source.requestId ||
    (source.method !== 'GET' && source.method !== 'HEAD') ||
    typeof source.url !== 'string' ||
    Buffer.byteLength(source.url, 'utf8') < 1 ||
    Buffer.byteLength(source.url, 'utf8') > 2_048
  ) {
    throw new ArtifactBrokerError('INVALID_REQUEST', requestId);
  }
  return {
    protocolVersion: 1,
    type: 'artifact.network.fetch.request',
    requestId,
    method: source.method,
    url: source.url,
  };
};
