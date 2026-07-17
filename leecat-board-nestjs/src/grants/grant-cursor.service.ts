import { TextDecoder } from 'node:util';

import { AppError } from '../common/errors/app-error.js';
import { CryptoService } from '../common/security/crypto.service.js';
import { decodeBase64UrlStrict, encodeBase64Url } from '../config/security.constants.js';

export interface GrantCursorTuple {
  createdAt: string;
  id: string;
}

const MAX_UNSIGNED_BIGINT = 18_446_744_073_709_551_615n;
const decoder = new TextDecoder('utf-8', { fatal: true });

const validateTuple = (tuple: GrantCursorTuple): GrantCursorTuple => {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(tuple.createdAt)) {
    throw new AppError('INVALID_PAYLOAD');
  }
  const time = Date.parse(tuple.createdAt);
  if (!Number.isSafeInteger(time) || new Date(time).toISOString() !== tuple.createdAt) {
    throw new AppError('INVALID_PAYLOAD');
  }
  if (!/^(?:0|[1-9][0-9]*)$/.test(tuple.id) || BigInt(tuple.id) > MAX_UNSIGNED_BIGINT) {
    throw new AppError('INVALID_PAYLOAD');
  }
  return tuple;
};

export class GrantCursorService {
  constructor(private readonly crypto: CryptoService) {}

  issue(ownerPublicId: string, input: GrantCursorTuple): string {
    const tuple = validateTuple(input);
    const payload = Buffer.from(JSON.stringify({ v: 1, createdAt: tuple.createdAt, id: tuple.id }), 'utf8');
    const mac = this.mac(ownerPublicId, payload);
    const cursor = `lcgc_v1.${encodeBase64Url(payload)}.${encodeBase64Url(mac)}`;
    if (cursor.length > 512) throw new Error('grant cursor exceeds its wire limit');
    return cursor;
  }

  parse(ownerPublicId: string, cursor: string): GrantCursorTuple {
    try {
      if (cursor.length > 512) throw new Error('cursor too long');
      const parts = cursor.split('.');
      if (parts.length !== 3 || parts[0] !== 'lcgc_v1' || parts[1] === undefined || parts[2] === undefined) {
        throw new Error('invalid cursor structure');
      }
      const payload = decodeBase64UrlStrict(parts[1]);
      const providedMac = decodeBase64UrlStrict(parts[2], { exactBytes: 32 });
      if (!this.crypto.constantTimeEqual(providedMac, this.mac(ownerPublicId, payload))) {
        throw new Error('invalid cursor signature');
      }
      const text = decoder.decode(payload);
      const decoded = JSON.parse(text) as unknown;
      if (decoded === null || typeof decoded !== 'object' || Array.isArray(decoded)) throw new Error('invalid cursor payload');
      const record = decoded as Record<string, unknown>;
      if (
        Object.keys(record).join(',') !== 'v,createdAt,id'
        || record.v !== 1
        || typeof record.createdAt !== 'string'
        || typeof record.id !== 'string'
      ) throw new Error('invalid cursor fields');
      const tuple = validateTuple({ createdAt: record.createdAt, id: record.id });
      const canonical = JSON.stringify({ v: 1, createdAt: tuple.createdAt, id: tuple.id });
      if (text !== canonical) throw new Error('non-canonical cursor payload');
      return tuple;
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError('INVALID_PAYLOAD');
    }
  }

  private mac(ownerPublicId: string, payload: Uint8Array): Buffer {
    return this.crypto.hmac(
      'grant-list-cursor/v1',
      Buffer.concat([Buffer.from(ownerPublicId, 'utf8'), Buffer.from([0]), Buffer.from(payload)]),
    );
  }
}
