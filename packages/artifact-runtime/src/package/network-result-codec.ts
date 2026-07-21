const NETWORK_MAGIC = new Uint8Array([76, 67, 78, 69, 84, 86, 49, 0]);
const NETWORK_MEDIA_TYPES = ['text/plain', 'application/json', 'image/png'] as const;

export type ArtifactNetworkResultV1 = {
  status: number;
  mediaType: (typeof NETWORK_MEDIA_TYPES)[number];
  body: Uint8Array;
};

export const decodeArtifactNetworkResultV1 = (
  input: ArrayBuffer | Uint8Array,
): ArtifactNetworkResultV1 => {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.byteLength < 18 || bytes.byteLength > 1_048_576 + 64)
    throw new TypeError('network result framing is invalid');
  for (let index = 0; index < NETWORK_MAGIC.length; index += 1) {
    if (bytes[index] !== NETWORK_MAGIC[index])
      throw new TypeError('network result magic is invalid');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const status = view.getUint32(8, false);
  const mediaLength = view.getUint16(12, false);
  const bodyLengthOffset = 14 + mediaLength;
  if (bodyLengthOffset + 4 > bytes.byteLength) throw new TypeError('network result is truncated');
  let mediaType: string;
  try {
    mediaType = new TextDecoder('utf-8', { fatal: true }).decode(
      bytes.subarray(14, bodyLengthOffset),
    );
  } catch {
    throw new TypeError('network result media type is invalid');
  }
  const bodyLength = view.getUint32(bodyLengthOffset, false);
  const bodyOffset = bodyLengthOffset + 4;
  if (
    status < 200 ||
    status > 299 ||
    !NETWORK_MEDIA_TYPES.includes(mediaType as (typeof NETWORK_MEDIA_TYPES)[number]) ||
    bodyLength > 1_048_576 ||
    bodyOffset + bodyLength !== bytes.byteLength
  ) {
    throw new TypeError('network result certification failed');
  }
  return {
    status,
    mediaType: mediaType as ArtifactNetworkResultV1['mediaType'],
    body: bytes.subarray(bodyOffset),
  };
};
