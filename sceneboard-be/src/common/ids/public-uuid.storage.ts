import { randomUUID } from 'node:crypto';

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type PublicUuidV4Bytes = Uint8Array & { readonly __publicUuidV4Bytes: unique symbol };

export const parsePublicUuidV4 = (value: string): PublicUuidV4Bytes => {
  if (!UUID_V4_PATTERN.test(value)) throw new TypeError('value must be a canonical UUIDv4');
  return Buffer.from(value.replaceAll('-', ''), 'hex') as unknown as PublicUuidV4Bytes;
};

export const formatPublicUuidV4 = (bytes: Uint8Array): string => {
  if (bytes.byteLength !== 16)
    throw new TypeError('UUID storage value must contain exactly 16 bytes');
  const hex = Buffer.from(bytes).toString('hex');
  const value = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  if (!UUID_V4_PATTERN.test(value))
    throw new TypeError('UUID storage value is not a canonical UUIDv4');
  return value;
};

export const generatePublicUuidV4 = (generate: () => string = randomUUID): string => {
  const value = generate();
  parsePublicUuidV4(value);
  return value;
};
