import { createHmac } from 'node:crypto';

export type CursorMacKeyV1 = Readonly<Uint8Array> & { readonly __cursorMacKeyV1: unique symbol };

const materialByHandle = new WeakMap<object, Buffer>();

export const createCursorMacKeyV1 = (input: Uint8Array): CursorMacKeyV1 => {
  if (input.byteLength < 32) throw new TypeError('cursor MAC key must contain at least 32 bytes');
  const handle = Object.freeze(new Uint8Array(0)) as unknown as CursorMacKeyV1;
  materialByHandle.set(handle, Buffer.from(input));
  return handle;
};

export const cursorHmacSha256V1 = (
  key: CursorMacKeyV1,
  domain: string,
  payload: Uint8Array,
): Buffer => {
  const material = materialByHandle.get(key);
  if (material === undefined || !domain.endsWith('\0')) throw new TypeError('invalid cursor MAC input');
  return createHmac('sha256', material)
    .update(Buffer.from(domain, 'utf8'))
    .update(payload)
    .digest();
};
