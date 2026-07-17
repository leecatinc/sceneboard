import { timingSafeEqual } from 'node:crypto';

export const ACCESS_TOKEN_PATTERN_V1 = /^lcbg_v1\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/;
export const GENERATION_PATTERN_V1 = /^[A-Za-z0-9_-]{22}$/;

export type CredentialRecordV1 = {
  version: 1;
  generation: string;
  accessToken: string;
};

export const parseCredentialRecordV1 = (bytes: Uint8Array): CredentialRecordV1 => {
  if (bytes.byteLength === 0 || bytes.byteLength > 512) throw new Error('credential record is invalid');
  let source: string;
  try {
    source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error('credential record is invalid');
  }
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    throw new Error('credential record is invalid');
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('credential record is invalid');
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.join('\0') !== ['accessToken', 'generation', 'version'].join('\0') || record.version !== 1
    || typeof record.generation !== 'string' || !GENERATION_PATTERN_V1.test(record.generation)
    || typeof record.accessToken !== 'string' || !ACCESS_TOKEN_PATTERN_V1.test(record.accessToken)
    || JSON.stringify(record) !== source) throw new Error('credential record is invalid');
  return { version: 1, generation: record.generation, accessToken: record.accessToken };
};

export const sameCredentialV1 = (left: CredentialRecordV1, right: CredentialRecordV1): boolean => {
  if (left.generation !== right.generation) return false;
  const leftToken = Buffer.from(left.accessToken, 'ascii');
  const rightToken = Buffer.from(right.accessToken, 'ascii');
  return leftToken.byteLength === rightToken.byteLength && timingSafeEqual(leftToken, rightToken);
};
